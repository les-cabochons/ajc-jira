import { adfToMarkdown, adfToMarkdownParts, type AdfImageContext, type AdfNode } from "./adf-markdown.js";
import { markdownToAdf, type AdfDocument, type AdfOutNode } from "./markdown-adf.js";
import {
  AMBIGUOUS_EDIT,
  alignLines,
  placeBoundaryNodes,
  reconcileDocument,
  restoreKeptNodes,
  withoutIdentity,
} from "./description-nested.js";

export { AMBIGUOUS_EDIT };

// Writes an edited description back into its ADF, keeping every top-level
// block the user did not change exactly as it was, attributes and formatting
// Markdown cannot hold included, and the empty paragraphs between blocks
// wherever the blank line there stayed. Only what changed is written from
// the Markdown. A block found where the user moved it is kept too. When
// blocks that read the same differ in Jira and the edit leaves it open which
// one stayed, the write is refused rather than guessed.

/** The lines both start and end with, when a full diff costs too much. */
function edgeMatch(before: string[], after: string[]) {
  const match = new Array<number>(before.length).fill(-1);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    match[head] = head;
    head += 1;
  }
  for (
    let tail = 0;
    tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail];
    tail += 1
  ) {
    match[before.length - 1 - tail] = after.length - 1 - tail;
  }
  return match;
}

function isBlank(line: string | undefined) {
  return line !== undefined && /^[ \t]*$/.test(line);
}

function editedLines(markdown: string) {
  return markdown.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "").split("\n");
}

/** The blocks Markdown makes, each as it reads back. */
function blocksOf(text: string, context: AdfImageContext) {
  return (adfToMarkdownParts(markdownToAdf(text), context)?.parts ?? []).map((part) => part.markdown);
}

/**
 * The ADF for `markdown`, an edit of the description `source` holds. Each
 * top-level block whose Markdown the edit kept, whole and in order, or moved
 * whole, stays the block it was, where it is now; the rest is written from the
 * Markdown. The pieces must read as the whole Markdown does: a kept block
 * that the Markdown around it would read otherwise, as a list right above new
 * list items, joins the change. Throws `AMBIGUOUS_EDIT` when blocks that read
 * the same but differ in ADF could have stayed in more than one way.
 */
export function patchDescriptionAdf(source: unknown, markdown: string, context: AdfImageContext): AdfDocument {
  const after = editedLines(markdown);
  const whole = markdownToAdf(after.join("\n"));
  const read = adfToMarkdownParts(source, context);
  if (!read) return whole;
  const { content, parts } = read;
  // A description of empty lines only keeps them after the new text.
  if (parts.length === 0) return { ...whole, content: [...whole.content, ...(content as AdfOutNode[])] };
  const target = JSON.stringify(blocksOf(after.join("\n"), context));

  // Each part's lines in the Markdown read from the source, and the blank
  // line that stands for the gap before each part after the first.
  const before: string[] = [];
  const gapAtLine = new Map<number, number>();
  const spans = parts.map((part, index) => {
    if (index > 0) {
      gapAtLine.set(before.length, index - 1);
      before.push("");
    }
    const start = before.length;
    before.push(...part.markdown.split("\n"));
    return { start, end: before.length };
  });
  const aligned = alignLines(before, after);
  const match = aligned?.match ?? edgeMatch(before, after);
  // The gaps whose blank line stayed, by the line it stayed as.
  const gapAfterLine = new Map<number, number>();
  for (const [line, gap] of gapAtLine) {
    if (match[line]! >= 0) gapAfterLine.set(match[line]!, gap);
  }

  // A part is kept when all its lines stay, together and in order. Whether
  // the text around it lets it stand alone is checked once the pieces are set.
  const placed: ({ start: number; end: number } | undefined)[] = spans.map(({ start, end }) => {
    const first = match[start]!;
    if (first === -1) return undefined;
    for (let line = start; line < end; line += 1) {
      if (match[line] !== first + (line - start)) return undefined;
    }
    return { start: first, end: first + (end - start) };
  });

  // Parts that read the same, and whether their ADF differs beyond ids. Twins
  // that differ only in ids are not ambiguous: the final pass keeps the
  // earliest of them, in order.
  const groups = new Map<string, number[]>();
  parts.forEach((part, index) => groups.set(part.markdown, [...(groups.get(part.markdown) ?? []), index]));
  const differs = (members: number[]) =>
    new Set(members.map((index) => withoutIdentity(content[parts[index]!.index]))).size > 1;
  const editedBlocks = JSON.parse(target) as string[];
  for (const [text, members] of groups) {
    if (members.length < 2 || !differs(members)) continue;
    // Without a full diff, or with fewer of them left, which stayed is unknown.
    const reads = blocksOf(text, context).join("\n\n");
    if (!aligned || editedBlocks.filter((block) => block === reads).length < members.length) {
      throw new Error(AMBIGUOUS_EDIT);
    }
    for (const index of members) {
      const { start, end } = spans[index]!;
      for (let line = start; line < end; line += 1) {
        if (aligned.optional[line] || (placed[index] && !aligned.certain[line])) throw new Error(AMBIGUOUS_EDIT);
      }
    }
  }

  // Blocks the diff did not keep in order, found whole elsewhere: moved.
  const taken = new Set<number>();
  placed.forEach((place) => {
    for (let line = place?.start ?? 0; place && line < place.end; line += 1) taken.add(line);
  });
  for (const [text, members] of groups) {
    const unplaced = members.filter((index) => !placed[index]);
    if (unplaced.length === 0) continue;
    const lines = text.split("\n");
    const found: number[] = [];
    for (let start = 0; start + lines.length <= after.length; start += 1) {
      let free = true;
      for (let offset = 0; offset < lines.length && free; offset += 1) {
        free = after[start + offset] === lines[offset] && !taken.has(start + offset);
      }
      if (free) {
        found.push(start);
        start += lines.length - 1;
      }
    }
    if (found.length === 0) continue;
    if (unplaced.length > 1 && differs(unplaced)) throw new Error(AMBIGUOUS_EDIT);
    unplaced.slice(0, found.length).forEach((index, order) => {
      const start = found[order]!;
      placed[index] = { start, end: start + lines.length };
      for (let line = start; line < start + lines.length; line += 1) taken.add(line);
    });
  }

  /**
   * The document with each rebuilt block given what its source block keeps,
   * below the top level. It must read as it did; otherwise the guard, which
   * the write runs, decides.
   */
  const reconcile = (document: AdfDocument): AdfDocument => {
    const reconciled = {
      ...document,
      content: placeBoundaryNodes(
        content,
        restoreKeptNodes(
          content,
          reconcileDocument(content, parts.map((part) => content[part.index]!), document.content as AdfNode[], context),
          context,
        ),
        context,
      ) as AdfOutNode[],
    };
    return adfToMarkdown(reconciled, context) === adfToMarkdown(document, context) ? reconciled : document;
  };

  /** The empty paragraphs and other blocks with no Markdown between two parts. */
  const gapNodes = (gap: number) => content.slice(parts[gap]!.index + 1, parts[gap + 1]!.index);

  /** The document with the parts `placed` keeps, and the Markdown of each piece. */
  const build = (splitAtGaps: boolean) => {
    const keptAt = new Map<number, number>();
    placed.forEach((place, index) => {
      if (place) keptAt.set(place.start, index);
    });
    type Piece = { nodes: unknown[]; text: string; part?: number; blankGap?: number };
    const pieces: Piece[] = [];
    let pendingGap: number | undefined;
    for (let line = 0; line < after.length; ) {
      if (isBlank(after[line])) {
        pendingGap ??= gapAfterLine.get(line);
        line += 1;
        continue;
      }
      const index = keptAt.get(line);
      if (index !== undefined) {
        pieces.push({ nodes: [content[parts[index]!.index]], text: parts[index]!.markdown, part: index, blankGap: pendingGap });
        pendingGap = undefined;
        line = placed[index]!.end;
        continue;
      }
      // New or changed text, up to the next kept block, or blank line that stayed.
      const start = line;
      while (line < after.length && !keptAt.has(line) && !(splitAtGaps && gapAfterLine.has(line))) line += 1;
      const text = after.slice(start, line).join("\n");
      pieces.push({ nodes: markdownToAdf(text).content, text, blankGap: pendingGap });
      pendingGap = undefined;
    }

    // The empty lines between two source blocks, by their boundaries: right
    // after the kept block before them, else right before the kept block
    // after them, else where their blank line stayed.
    // Two such gaps can meet at one place, as when the block between them
    // goes: the one after the kept block comes first.
    const gapAt = Array.from({ length: pieces.length + 1 }, () => [] as number[]);
    const usedGaps = new Set<number>();
    const place = (at: number, gap: number, onlyIfFree = false) => {
      if (gap < 0 || gap >= parts.length - 1 || usedGaps.has(gap)) return;
      if (onlyIfFree && gapAt[at]!.length > 0) return;
      // Two blocks with nothing between them leave the place free.
      if (gapNodes(gap).length === 0) return;
      gapAt[at]!.push(gap);
      usedGaps.add(gap);
    };
    pieces.forEach((piece, at) => piece.part !== undefined && place(at + 1, piece.part));
    pieces.forEach((piece, at) => piece.part !== undefined && place(at, piece.part - 1));
    pieces.forEach((piece, at) => at > 0 && piece.blankGap !== undefined && place(at, piece.blankGap, true));

    const out: unknown[] = content.slice(0, parts[0]!.index);
    for (const gap of gapAt[0]!) out.push(...gapNodes(gap));
    pieces.forEach((piece, at) => {
      out.push(...piece.nodes);
      for (const gap of gapAt[at + 1]!) out.push(...gapNodes(gap));
    });
    out.push(...content.slice(parts[parts.length - 1]!.index + 1));
    const document: AdfDocument = { type: "doc", version: 1, content: out as AdfOutNode[] };
    return { document, pieces: pieces.map((piece) => piece.text) };
  };

  for (;;) {
    for (const splitAtGaps of [true, false]) {
      const { document, pieces } = build(splitAtGaps);
      // Kept blocks read as they did, even one whose Markdown would not
      // write back as itself: the user left it alone.
      if (JSON.stringify(pieces.flatMap((piece) => blocksOf(piece, context))) === target) return reconcile(document);
    }
    if (placed.every((place) => !place)) return reconcile(build(false).document);
    // The kept blocks next to changed text join it, and the write is tried
    // again. The write's guard then checks what went.
    const kept = new Set<number>();
    for (const place of placed) {
      for (let line = place?.start ?? 0; place && line < place.end; line += 1) kept.add(line);
    }
    // First the blocks the changed text touches, then those a blank line
    // away from it.
    const touchesChange = (from: number, step: number, acrossBlanks: boolean) => {
      let line = from;
      while (acrossBlanks && line >= 0 && line < after.length && isBlank(after[line])) line += step;
      return line >= 0 && line < after.length && !isBlank(after[line]) && !kept.has(line);
    };
    let unkept = false;
    for (const acrossBlanks of [false, true]) {
      placed.forEach((place, index) => {
        if (
          place &&
          (touchesChange(place.start - 1, -1, acrossBlanks) || touchesChange(place.end, 1, acrossBlanks))
        ) {
          placed[index] = undefined;
          unkept = true;
        }
      });
      if (unkept) break;
    }
    if (!unkept) placed.fill(undefined);
  }
}
