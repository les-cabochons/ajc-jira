import { adfToMarkdownParts, type AdfImageContext } from "./adf-markdown.js";
import { markdownToAdf, type AdfDocument, type AdfOutNode } from "./markdown-adf.js";

// Writes an edited description back into its ADF, keeping every top-level
// block the user did not change exactly as it was, attributes and formatting
// Markdown cannot hold included, and the empty paragraphs between blocks
// wherever the blank line there stayed. Only what changed is written from
// the Markdown.

/** Past this many line pairs, a line diff costs too much; only the edges are matched. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * For each line of `before`, the line of `after` it stays as, or -1: the
 * lines both start and end with, then a longest common subsequence between.
 */
function matchLines(before: string[], after: string[]): number[] {
  const match = new Array<number>(before.length).fill(-1);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    match[head] = head;
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    match[before.length - 1 - tail] = after.length - 1 - tail;
    tail += 1;
  }
  const n = before.length - head - tail;
  const m = after.length - head - tail;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return match;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        before[head + i] === after[head + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (before[head + i] === after[head + j]) {
      match[head + i] = head + j;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

function isBlank(line: string | undefined) {
  return line !== undefined && /^[ \t]*$/.test(line);
}

/**
 * The ADF for `markdown`, an edit of the description `source` holds. Each
 * top-level block whose Markdown the edit kept, whole and set apart by blank
 * lines, stays the block it was; the rest is written from the Markdown. The
 * pieces must read as the whole Markdown does: a kept block that the Markdown
 * around it would read otherwise, as a list right above new list items, joins
 * the change, and the write is tried again.
 */
export function patchDescriptionAdf(source: unknown, markdown: string, context: AdfImageContext): AdfDocument {
  const after = markdown.replace(/\r\n?/g, "\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "").split("\n");
  const whole = markdownToAdf(after.join("\n"));
  const read = adfToMarkdownParts(source, context);
  if (!read || read.parts.length === 0) return whole;
  const { content, parts } = read;
  /** The blocks Markdown makes, each as it reads back. */
  const blocksOf = (text: string) =>
    (adfToMarkdownParts(markdownToAdf(text), context)?.parts ?? []).map((part) => part.markdown);
  const target = JSON.stringify(blocksOf(after.join("\n")));

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
  const match = matchLines(before, after);
  // The gaps whose blank line stayed, by the line it stayed as.
  const gapAfterLine = new Map<number, number>();
  for (const [line, gap] of gapAtLine) {
    if (match[line]! >= 0) gapAfterLine.set(match[line]!, gap);
  }

  // A part is kept when all its lines stay, together and in order, with a
  // blank line or an edge on each side.
  const placed = spans.map(({ start, end }) => {
    const first = match[start]!;
    if (first === -1) return undefined;
    for (let line = start; line < end; line += 1) {
      if (match[line] !== first + (line - start)) return undefined;
    }
    const last = first + (end - start);
    const apart = (first === 0 || isBlank(after[first - 1])) && (last === after.length || isBlank(after[last]));
    return apart ? { start: first, end: last } : undefined;
  });

  /** The empty paragraphs and other blocks with no Markdown between two parts. */
  const gapNodes = (gap: number) => content.slice(parts[gap]!.index + 1, parts[gap + 1]!.index);

  /** The document with the parts `placed` keeps, and the Markdown of each piece. */
  const build = (splitAtGaps: boolean) => {
    const keptAt = new Map<number, number>();
    placed.forEach((place, index) => {
      if (place) keptAt.set(place.start, index);
    });
    const out: unknown[] = content.slice(0, parts[0]!.index);
    const pieces: string[] = [];
    let pendingGap: number | undefined;
    const push = (nodes: unknown[], text: string) => {
      if (pendingGap !== undefined && pieces.length > 0) out.push(...gapNodes(pendingGap));
      pendingGap = undefined;
      out.push(...nodes);
      pieces.push(text);
    };
    for (let line = 0; line < after.length; ) {
      if (isBlank(after[line])) {
        pendingGap ??= gapAfterLine.get(line);
        line += 1;
        continue;
      }
      const index = keptAt.get(line);
      if (index !== undefined) {
        push([content[parts[index]!.index]], parts[index]!.markdown);
        line = placed[index]!.end;
        continue;
      }
      // New or changed text, up to the next kept block, or blank line that stayed.
      const start = line;
      while (line < after.length && !keptAt.has(line) && !(splitAtGaps && gapAfterLine.has(line))) line += 1;
      const text = after.slice(start, line).join("\n");
      push(markdownToAdf(text).content, text);
    }
    out.push(...content.slice(parts[parts.length - 1]!.index + 1));
    const document: AdfDocument = { type: "doc", version: 1, content: out as AdfOutNode[] };
    return { document, pieces };
  };

  for (;;) {
    for (const splitAtGaps of [true, false]) {
      const { document, pieces } = build(splitAtGaps);
      // Kept blocks read as they did, even one whose Markdown would not
      // write back as itself: the user left it alone.
      if (JSON.stringify(pieces.flatMap(blocksOf)) === target) return document;
    }
    if (placed.every((place) => !place)) return build(false).document;
    // The kept blocks next to changed text join it, and the write is tried again.
    const kept = new Set<number>();
    for (const place of placed) {
      for (let line = place?.start ?? 0; place && line < place.end; line += 1) kept.add(line);
    }
    const touchesChange = (from: number, step: number) => {
      let line = from;
      while (line >= 0 && line < after.length && isBlank(after[line])) line += step;
      return line >= 0 && line < after.length && !kept.has(line);
    };
    let unkept = false;
    placed.forEach((place, index) => {
      if (place && (touchesChange(place.start - 1, -1) || touchesChange(place.end, 1))) {
        placed[index] = undefined;
        unkept = true;
      }
    });
    if (!unkept) placed.fill(undefined);
  }
}
