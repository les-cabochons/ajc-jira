import { adfToMarkdown, type AdfImageContext, type AdfNode } from "./adf-markdown.js";

// What keeps a description's untouched parts exactly as they were below the
// top level. When the write rebuilds a block from Markdown, its children are
// aligned with the source block's children by their Markdown: a child that
// reads the same is the source child itself, ids and attributes included, and
// a changed child that lines up with one source child takes over that child's
// ids and the attributes Markdown has no place for, down to the mentions, inline
// files and smart links of its text. The write then checks the result with
// description-guard.ts, which shares none of this alignment.

/** Past this many pairs, a diff costs too much. */
const MAX_DIFF_CELLS = 4_000_000;

export const AMBIGUOUS_EDIT =
  "This edit moves or removes blocks that read the same but differ in Jira, so Ajour cannot tell which you kept. Edit the description in Jira.";

export const UNPLACED_EDIT =
  "Ajour cannot tell where a line break or an empty line of this description went with your edit. Edit the description in Jira.";

export const EDIT_TOO_LARGE =
  "This edit is too large for Ajour to keep the rest of the description as it is. Edit the description in Jira.";

/**
 * A longest common subsequence diff of two lists of strings, weighing every
 * optimal alignment. `match` is one of them; an item is `certain` when every
 * optimal alignment matches it to that same item, and `optional` when some
 * match it and some do not, or match it elsewhere. Undefined past the budget.
 */
export function alignLines(before: string[], after: string[]) {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  if ((n + 1) * width > MAX_DIFF_CELLS) return undefined;
  const prefix = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      prefix[i * width + j] =
        before[i - 1] === after[j - 1]
          ? prefix[(i - 1) * width + j - 1]! + 1
          : Math.max(prefix[(i - 1) * width + j]!, prefix[i * width + j - 1]!);
    }
  }
  const suffix = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      suffix[i * width + j] =
        before[i] === after[j]
          ? suffix[(i + 1) * width + j + 1]! + 1
          : Math.max(suffix[(i + 1) * width + j]!, suffix[i * width + j + 1]!);
    }
  }
  const total = suffix[0]!;

  const match = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (before[i] === after[j] && suffix[i * width + j] === suffix[(i + 1) * width + j + 1]! + 1) {
      match[i] = j;
      i += 1;
      j += 1;
    } else if (suffix[(i + 1) * width + j]! > suffix[i * width + j + 1]!) {
      i += 1;
    } else {
      // On a tie, an earlier source item keeps its chance to match: the
      // earliest of twins is the one kept.
      j += 1;
    }
  }

  const certain = new Array<boolean>(n).fill(false);
  const optional = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    let pairs = 0;
    let skippable = false;
    for (let j = 0; j <= m; j += 1) {
      if (prefix[i * width + j]! + suffix[(i + 1) * width + j]! === total) skippable = true;
      if (j < m && before[i] === after[j] && prefix[i * width + j]! + 1 + suffix[(i + 1) * width + j + 1]! === total) {
        pairs += 1;
      }
    }
    certain[i] = pairs === 1 && !skippable;
    optional[i] = pairs > 0 && !certain[i];
  }
  return { match, certain, optional };
}


/** A document that holds only `node`, as the reader reads it where it stands. */
export function documentOf(node: AdfNode): AdfNode {
  const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
  switch (node.type) {
    case "listItem":
      return doc({ type: "bulletList", content: [node] });
    case "taskItem":
      return doc({ type: "taskList", attrs: { localId: "" }, content: [node] });
    case "decisionItem":
      return doc({ type: "decisionList", attrs: { localId: "" }, content: [node] });
    case "tableRow":
      return doc({ type: "table", content: [node] });
    case "tableCell":
    case "tableHeader":
      return doc({ type: "table", content: [{ type: "tableRow", content: [node] }] });
    case "media":
      return doc({ type: "mediaSingle", attrs: { layout: "center" }, content: [node] });
    case "caption":
      return doc({ type: "paragraph", content: Array.isArray(node.content) ? node.content : [] });
    default:
      return INLINE_TYPES.has(String(node.type)) ? doc({ type: "paragraph", content: [node] }) : doc(node);
  }
}

const INLINE_TYPES = new Set([
  "text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status", "mediaInline", "placeholder", "inlineExtension",
]);

/** Nodes whose content is text and inline atoms. */
const INLINE_CONTAINERS = new Set(["paragraph", "heading", "taskItem", "decisionItem", "caption", "codeBlock"]);

/** How a node reads in Markdown, which says whether the user changed it. */
function keyOf(node: AdfNode, context: AdfImageContext) {
  return adfToMarkdown(documentOf(node), context) ?? "";
}

/**
 * Attributes Markdown has no place for and the reader names no loss for:
 * ids, and values the writer would give as defaults.
 */
function isNeutralAttribute(type: unknown, name: string, value: unknown) {
  if (name === "localId") return true;
  switch (type) {
    case "mention":
      return name === "accessLevel" || name === "userType";
    case "codeBlock":
      return name === "uniqueId";
    case "hardBreak":
      return name === "text";
    case "table":
      return (
        (name === "isNumberColumnEnabled" && value === false) ||
        (name === "layout" && (value === "default" || value === "center")) ||
        (name === "width" && value === 760) ||
        (name === "displayMode" && value === "default")
      );
    case "tableCell":
    case "tableHeader":
      return (name === "colspan" || name === "rowspan") && value === 1;
    case "orderedList":
      return name === "order" && value === 1;
    default:
      return false;
  }
}

/** The source node's neutral attributes, on the rebuilt node that replaces it. */
function carryAttributes(source: AdfNode, rebuilt: AdfNode): AdfNode {
  const attrs: Record<string, unknown> = { ...(rebuilt.attrs ?? {}) };
  for (const [name, value] of Object.entries(source.attrs ?? {})) {
    if (!isNeutralAttribute(source.type, name, value)) continue;
    if (!(name in attrs) || name === "localId" || isNeutralAttribute(rebuilt.type, name, attrs[name])) attrs[name] = value;
  }
  const result: AdfNode = { ...rebuilt };
  if (Object.keys(attrs).length > 0 || source.attrs !== undefined) result.attrs = attrs;
  else delete result.attrs;
  return result;
}


function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content as AdfNode[]) : [];
}

type Pair = { source: AdfNode; written: AdfNode; same: boolean };

/**
 * Lines up a source node's children with a rebuilt node's by their Markdown.
 * Children that read the same pair where every optimal alignment agrees; when
 * they could pair in more than one way and differ in Jira, the edit is
 * ambiguous. Between those, changed children pair in order when both runs
 * hold the same kinds of node, or by kind when a kind occurs once on each side.
 */
function pairItems(sources: AdfNode[], written: AdfNode[], context: AdfImageContext): Pair[] {
  const sourceKeys = sources.map((node) => keyOf(node, context));
  const writtenKeys = written.map((node) => keyOf(node, context));
  const aligned = alignLines(sourceKeys, writtenKeys);
  if (!aligned) throw new Error(EDIT_TOO_LARGE);
  const groups = new Map<string, AdfNode[]>();
  sources.forEach((node, index) => groups.set(sourceKeys[index]!, [...(groups.get(sourceKeys[index]!) ?? []), node]));
  sources.forEach((_, index) => {
    const uncertain = aligned.optional[index] || (aligned.match[index]! >= 0 && !aligned.certain[index]);
    const group = groups.get(sourceKeys[index]!)!;
    const differs = group.length > 1 && new Set(group.map(withoutIdentity)).size > 1;
    // Fewer of them left than there were: which survived is open.
    const left = writtenKeys.filter((key) => key === sourceKeys[index]).length;
    if (differs && (uncertain || left < group.length)) throw new Error(AMBIGUOUS_EDIT);
  });

  const pairs: Pair[] = [];
  // A child the user moved without changing it reads the same in another
  // place: it pairs when its Markdown is unique among the unpaired children on
  // both sides, before any guess about changed children.
  const matchedWritten = new Set(aligned.match.filter((at) => at >= 0));
  const unpairedSources = sources.map((_, index) => index).filter((index) => aligned.match[index] === -1);
  const unpairedWritten = written.map((_, index) => index).filter((index) => !matchedWritten.has(index));
  const moved = new Set<AdfNode>();
  for (const index of unpairedSources) {
    const key = sourceKeys[index]!;
    const sameSource = unpairedSources.filter((other) => sourceKeys[other] === key);
    const sameWritten = unpairedWritten.filter((other) => writtenKeys[other] === key);
    if (sameSource.length === 1 && sameWritten.length === 1) {
      pairs.push({ source: sources[index]!, written: written[sameWritten[0]!]!, same: true });
      moved.add(sources[index]!);
      moved.add(written[sameWritten[0]!]!);
    }
  }
  let sourceAt = 0;
  let writtenAt = 0;
  const pairRun = (sourceEnd: number, writtenEnd: number) => {
    const sourceRun = sources.slice(sourceAt, sourceEnd).filter((node) => !moved.has(node));
    const writtenRun = written.slice(writtenAt, writtenEnd).filter((node) => !moved.has(node));
    if (sourceRun.length === writtenRun.length && sourceRun.every((node, index) => node.type === writtenRun[index]!.type)) {
      sourceRun.forEach((node, index) => pairs.push({ source: node, written: writtenRun[index]!, same: false }));
      return;
    }
    for (const node of sourceRun) {
      const sourceOfType = sourceRun.filter((other) => other.type === node.type);
      const writtenOfType = writtenRun.filter((other) => other.type === node.type);
      if (sourceOfType.length === 1 && writtenOfType.length === 1) {
        pairs.push({ source: node, written: writtenOfType[0]!, same: false });
      }
    }
  };
  sources.forEach((node, index) => {
    const at = aligned.match[index]!;
    if (at === -1) return;
    pairRun(index, at);
    pairs.push({ source: node, written: written[at]!, same: true });
    sourceAt = index + 1;
    writtenAt = at + 1;
  });
  pairRun(sources.length, written.length);
  return pairs;
}

/**
 * Lines up a source block's children with a rebuilt block's: the children
 * that read as something by `pairItems`, and those with no Markdown of their
 * own, as empty paragraphs, by their boundaries. At the start or the end of
 * the block, the start or the end; else right after the kept child before
 * them, else right before the kept child after them; the rest in order when
 * as many are left on each side. A source one left over that carries an id
 * or attributes cannot be placed, and nothing is written.
 */
function pairChildren(sources: AdfNode[], written: AdfNode[], context: AdfImageContext): Pair[] {
  const split = (nodes: AdfNode[]) => {
    const items: AdfNode[] = [];
    const gaps: AdfNode[][] = [[]];
    for (const node of nodes) {
      if (keyOf(node, context) === "") gaps[gaps.length - 1]!.push(node);
      else {
        items.push(node);
        gaps.push([]);
      }
    }
    return { items, gaps };
  };
  const sourceSide = split(sources);
  const writtenSide = split(written);
  const pairs = pairItems(sourceSide.items, writtenSide.items, context);
  if (sourceSide.gaps.every((gap) => gap.length === 0)) return pairs;

  // Where each kept source child stands among the written ones.
  const where = sourceSide.items.map((node) => {
    const pair = pairs.find((each) => each.same && each.source === node);
    return pair ? writtenSide.items.indexOf(pair.written) : -1;
  });
  const claimed = new Set<number>();
  const leftSource: AdfNode[] = [];
  const leftWritten: AdfNode[] = [];
  const last = sourceSide.gaps.length - 1;
  const order = [0, ...(last > 0 ? [last] : []), ...sourceSide.gaps.map((_, index) => index).slice(1, last)];
  for (const index of order) {
    const gap = sourceSide.gaps[index]!;
    if (gap.length === 0) continue;
    let target = -1;
    let fromEnd = false;
    if (index === 0) {
      target = 0;
    } else if (index === last) {
      target = writtenSide.gaps.length - 1;
      fromEnd = true;
    } else if (where[index - 1]! >= 0 && writtenSide.gaps[where[index - 1]! + 1]!.length > 0) {
      target = where[index - 1]! + 1;
    } else if (where[index]! >= 0 && writtenSide.gaps[where[index]!]!.length > 0) {
      target = where[index]!;
      fromEnd = true;
    }
    if (target === -1 || claimed.has(target)) {
      leftSource.push(...gap);
      continue;
    }
    claimed.add(target);
    const writtenGap = fromEnd ? [...writtenSide.gaps[target]!].reverse() : writtenSide.gaps[target]!;
    const sourceGap = fromEnd ? [...gap].reverse() : gap;
    sourceGap.forEach((node, at) =>
      at < writtenGap.length ? pairs.push({ source: node, written: writtenGap[at]!, same: true }) : leftSource.push(node),
    );
    leftWritten.push(...writtenGap.slice(sourceGap.length));
  }
  leftWritten.push(...writtenSide.gaps.flatMap((gap, index) => (claimed.has(index) ? [] : gap)));
  if (leftSource.length === leftWritten.length) {
    leftSource.forEach((node, at) => pairs.push({ source: node, written: leftWritten[at]!, same: true }));
  } else if (leftSource.some(carriesMore)) {
    throw new Error(UNPLACED_EDIT);
  }
  return pairs;
}

/** The identity of an inline atom the writer rebuilds from Markdown. */
function atomIdentity(node: AdfNode): string | undefined {
  switch (node.type) {
    case "mention":
    case "mediaInline":
      return `${node.type}:${String(node.attrs?.id)}`;
    case "inlineCard":
      return `inlineCard:${String(node.attrs?.url)}`;
    default:
      return undefined;
  }
}

/**
 * Pairs the inline atoms of a rebuilt run of text with the source's, person
 * by person, file by file: first those that read exactly the same, in order;
 * then a renamed one with the one source atom left. When which survived, or
 * which was renamed, is open and the source atoms differ, the edit is
 * ambiguous.
 */
function pairAtoms(sources: AdfNode[], written: AdfNode[], context: AdfImageContext): Pair[] {
  const pairs: Pair[] = [];
  const identities = new Set(written.map(atomIdentity).filter((identity) => identity !== undefined));
  for (const identity of identities) {
    const sourceAtoms = sources.filter((node) => atomIdentity(node) === identity);
    const writtenAtoms = written.filter((node) => atomIdentity(node) === identity);
    const used = new Set<AdfNode>();
    for (const key of new Set(writtenAtoms.map((node) => keyOf(node, context)))) {
      const sameSource = sourceAtoms.filter((node) => keyOf(node, context) === key);
      const sameWritten = writtenAtoms.filter((node) => keyOf(node, context) === key);
      if (sameWritten.length < sameSource.length && new Set(sameSource.map(withoutIdentity)).size > 1) {
        throw new Error(AMBIGUOUS_EDIT);
      }
      sameWritten.slice(0, sameSource.length).forEach((node, index) => {
        pairs.push({ source: sameSource[index]!, written: node, same: true });
        used.add(sameSource[index]!).add(node);
      });
    }
    const leftSource = sourceAtoms.filter((node) => !used.has(node));
    const leftWritten = writtenAtoms.filter((node) => !used.has(node));
    if (leftSource.length === 0 || leftWritten.length === 0) continue;
    // Renamed: a changed atom, so free, but it keeps its source's attributes
    // when which source atom it was is plain: as many on each side, and one,
    // or all agreeing on what a rename keeps. Otherwise nothing is carried.
    const kept = (node: AdfNode) =>
      JSON.stringify(Object.entries(node.attrs ?? {}).filter(([name]) => name !== "text" && name !== "localId"));
    if (leftSource.length !== leftWritten.length) continue;
    if (leftSource.length > 1 && new Set(leftSource.map(kept)).size > 1) continue;
    leftWritten.forEach((node, index) => pairs.push({ source: leftSource[index]!, written: node, same: false }));
  }
  // Hard breaks are kept by `restoreKeptNodes`, by the lines on each side.
  return pairs;
}

/**
 * A rebuilt node with what its source keeps: the source child itself for
 * each child that reads the same, and the neutral attributes of each changed
 * one, all the way down.
 */
export function reconcileNode(source: AdfNode, rebuilt: AdfNode, context: AdfImageContext): AdfNode {
  if (source.type !== rebuilt.type) return rebuilt;
  const result = carryAttributes(source, rebuilt);
  const written = childrenOf(rebuilt);
  if (written.length === 0) return result;
  let pairs: Pair[];
  if (INLINE_CONTAINERS.has(String(rebuilt.type))) {
    // Breaks and the atoms of kept lines by their lines, then other atoms by who or what they name.
    const linePairs = pairLines(childrenOf(source), written, context);
    const pairedSources = new Set(linePairs.map((pair) => pair.source));
    const pairedWritten = new Set(linePairs.map((pair) => pair.written));
    pairs = [
      ...linePairs,
      ...pairAtoms(
        childrenOf(source).filter((node) => !pairedSources.has(node)),
        written.filter((node) => !pairedWritten.has(node)),
        context,
      ),
    ];
  } else {
    pairs = pairChildren(childrenOf(source), written, context);
  }
  const replacement = new Map<AdfNode, AdfNode>();
  for (const pair of pairs) {
    replacement.set(pair.written, pair.same ? pair.source : reconcileNode(pair.source, pair.written, context));
  }
  result.content = written.map((node) => replacement.get(node) ?? node);
  return result;
}

/** Attributes that only name a node: neither content nor how it looks. */
const IDENTITY_ATTRIBUTES = new Set(["localId", "uniqueId"]);

/** A node as JSON without its ids, at every depth: attributes left empty count as none. */
export function withoutIdentity(node: unknown): string {
  return JSON.stringify(node, (key, value) => {
    if (IDENTITY_ATTRIBUTES.has(key)) return undefined;
    if (key === "attrs" && value && typeof value === "object" && Object.keys(value).every((name) => IDENTITY_ATTRIBUTES.has(name))) {
      return undefined;
    }
    return value;
  });
}

/** A node and every node under it. */
function subtree(node: AdfNode): AdfNode[] {
  return [node, ...childrenOf(node).flatMap(subtree)];
}

/** A node's place in a document, with its key and the places under it. */
type Slot = { node: AdfNode; key: string | undefined; place: string; children: Slot[] };

/** The Markdown of a run of siblings, inline or blocks. */
function runMarkdown(siblings: AdfNode[], inline: boolean, context: AdfImageContext) {
  const content = inline ? [{ type: "paragraph", content: siblings }] : siblings;
  return adfToMarkdown({ type: "doc", version: 1, content } as AdfNode, context) ?? "";
}

/**
 * The places of a run of siblings, each keyed by its kind and its own
 * Markdown, whatever its ancestors are. A node with no Markdown of its own,
 * as a hard break or an empty paragraph, has no key here: it is placed by its
 * boundaries, where its block is paired (`pairBreaks`, the top-level gaps).
 */
function slotsOf(siblings: AdfNode[], place: string, context: AdfImageContext): Slot[] {
  return siblings.map((node, index) => {
    const type = String(node.type);
    const markdown = type === "text" ? "" : keyOf(node, context);
    const at = `${place}/${index}`;
    return {
      node,
      key: markdown !== "" ? `${type}\u0000${markdown}` : undefined,
      place: at,
      children: slotsOf(childrenOf(node), at, context),
    };
  });
}

/** A longest common subsequence of two lists of keys, ties keeping earlier source items. */
function longestCommon(before: string[], after: string[]): number[] {
  const n = before.length;
  const m = after.length;
  const match = new Array<number>(n).fill(-1);
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) throw new Error(EDIT_TOO_LARGE);
  const width = m + 1;
  const suffix = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      suffix[i * width + j] =
        before[i] === after[j]
          ? suffix[(i + 1) * width + j + 1]! + 1
          : Math.max(suffix[(i + 1) * width + j]!, suffix[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (before[i] === after[j] && suffix[i * width + j] === suffix[(i + 1) * width + j + 1]! + 1) {
      match[i] = j;
      i += 1;
      j += 1;
    } else if (suffix[(i + 1) * width + j]! > suffix[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

/** A run of text split at its hard breaks: its lines, and the breaks between them. */
function linesOf(nodes: AdfNode[]) {
  const lines: AdfNode[][] = [[]];
  const breaks: AdfNode[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      breaks.push(node);
      lines.push([]);
    } else {
      lines[lines.length - 1]!.push(node);
    }
  }
  return { lines, breaks };
}

/** Whether a node with no Markdown carries more than a plain one: an id or any attribute but a break's own newline. */
function carriesMore(node: AdfNode) {
  return Object.entries(node.attrs ?? {}).some(([name, value]) => !(node.type === "hardBreak" && name === "text" && value === "\n"));
}

/**
 * The hard breaks and atoms of a rebuilt run of text that are its source's.
 * Lines are lined up by their Markdown. A source break stays as the break
 * after its line, or before the next one, when that line is kept and still
 * has a break on that side; the breaks left pair in order when as many are
 * left on each side, and otherwise a source break that carries an id or
 * attributes cannot be placed, and nothing is written. The atoms of a kept
 * line are that line's, in order.
 */
function pairLines(sources: AdfNode[], written: AdfNode[], context: AdfImageContext): Pair[] {
  const sourceSide = linesOf(sources);
  const writtenSide = linesOf(written);
  const line = (nodes: AdfNode[]) => runMarkdown(nodes, true, context);
  const match = longestCommon(sourceSide.lines.map(line), writtenSide.lines.map(line));
  const pairs: Pair[] = [];
  const claimed = new Set<number>();
  const leftSource: AdfNode[] = [];
  sourceSide.breaks.forEach((node, index) => {
    let target = -1;
    if (match[index]! >= 0 && match[index]! < writtenSide.breaks.length) target = match[index]!;
    else if (match[index + 1]! > 0) target = match[index + 1]! - 1;
    if (target === -1 || claimed.has(target)) {
      leftSource.push(node);
      return;
    }
    claimed.add(target);
    pairs.push({ source: node, written: writtenSide.breaks[target]!, same: true });
  });
  const leftWritten = writtenSide.breaks.filter((_, index) => !claimed.has(index));
  if (leftSource.length === leftWritten.length) {
    leftSource.forEach((node, at) => pairs.push({ source: node, written: leftWritten[at]!, same: true }));
  } else if (leftSource.some(carriesMore)) {
    throw new Error(UNPLACED_EDIT);
  }
  const atoms = (nodes: AdfNode[]) => nodes.filter((node) => node.type !== "text");
  sourceSide.lines.forEach((nodes, index) => {
    if (match[index]! < 0) return;
    const writtenAtoms = atoms(writtenSide.lines[match[index]!]!);
    atoms(nodes).forEach((node, at) => pairs.push({ source: node, written: writtenAtoms[at]!, same: true }));
  });
  return pairs;
}

function identitiesOf(node: AdfNode) {
  return [...IDENTITY_ATTRIBUTES].flatMap((name) => {
    const value = node.attrs?.[name];
    return typeof value === "string" && value !== "" ? [`${name}=${value}`] : [];
  });
}

/**
 * The last pass of a rebuild, which conserves the source: any written node
 * that reads the same as a source node the write does not hold yet becomes
 * that source node, ids and attributes included, wherever the alignment lost
 * track of it, as a mention whose paragraph became a heading, or a hard break
 * between the same two lines. Nodes written exactly are claimed first,
 * outermost first. Twins that differ only in ids are given in document order,
 * the earliest first. When the source nodes a node could be differ beyond
 * ids, the edit is ambiguous. A rebuilt node keeps no id a kept node holds.
 */
export function restoreKeptNodes(source: AdfNode[], written: AdfNode[], context: AdfImageContext): AdfNode[] {
  const candidates = new Map<string, AdfNode[]>();
  const index = (slots: Slot[]) => {
    for (const slot of slots) {
      if (slot.key) candidates.set(slot.key, [...(candidates.get(slot.key) ?? []), slot.node]);
      index(slot.children);
    }
  };
  index(slotsOf(source, "", context));
  const writtenSlots = slotsOf(written, "", context);

  const used = new Set<AdfNode>();
  const claimed = new Set<AdfNode>();
  const claim = (node: AdfNode) =>
    subtree(node).forEach((each) => {
      used.add(each);
      claimed.add(each);
    });
  const twinKeys = new Set(
    [...candidates].filter(([, nodes]) => nodes.length > 1 && new Set(nodes.map(withoutIdentity)).size === 1).map(([key]) => key),
  );
  // A node that reads as such twins, rebuilt or not, is given one in order.
  const isTwin = (slot: Slot) => slot.key !== undefined && twinKeys.has(slot.key);
  /** What each place becomes: a source node, or a copy without ids. */
  const replacement = new Map<string, AdfNode>();
  const exactPlaces = new Set<string>();

  // Source nodes the rebuild already put in place are claimed there first,
  // outermost first, so no other place takes them; twins are ordered below.
  const sourceNodes = new Set(source.flatMap(subtree));
  const inPlace = (slots: Slot[]) => {
    for (const slot of slots) {
      if (slot.node.type === "text" || isTwin(slot)) continue;
      if (
        sourceNodes.has(slot.node) &&
        !isTwin(slot) &&
        subtree(slot.node).every((each) => !used.has(each))
      ) {
        claim(slot.node);
        exactPlaces.add(slot.place);
        continue;
      }
      inPlace(slot.children);
    }
  };
  inPlace(writtenSlots);

  // Then outermost first across the whole document, so a block is restored
  // whole before the atoms inside another block are: a node becomes the source
  // node it is an exact copy of, else the one free source node it reads as.
  // Source nodes count as free only when none of their nodes stands elsewhere.
  // When the free ones it could be differ beyond ids, the edit is ambiguous.
  // Twins that differ only in ids are left to the pass after.
  for (let level = writtenSlots; level.length > 0; ) {
    const deeper: Slot[] = [];
    for (const slot of level) {
      if (slot.node.type === "text" || exactPlaces.has(slot.place)) continue;
      if (!slot.key || isTwin(slot)) {
        if (!slot.key) deeper.push(...slot.children);
        continue;
      }
      const json = JSON.stringify(slot.node);
      const free = (candidates.get(slot.key) ?? []).filter((candidate) => subtree(candidate).every((each) => !used.has(each)));
      const exact = free.find((candidate) => JSON.stringify(candidate) === json);
      if (exact) {
        claim(exact);
        exactPlaces.add(slot.place);
        continue;
      }
      if (free.length > 0) {
        if (new Set(free.map(withoutIdentity)).size > 1) throw new Error(AMBIGUOUS_EDIT);
        claim(free[0]!);
        replacement.set(slot.place, free[0]!);
        continue;
      }
      deeper.push(...slot.children);
    }
    level = deeper;
  }

  // Twins that differ only in ids: each written twin, in document order, is
  // the earliest source twin not yet written whose nodes are all still free.
  // A twin past the source's count is the user's copy, with no ids.
  const twins = (slots: Slot[]) => {
    for (const slot of slots) {
      if (exactPlaces.has(slot.place) || replacement.has(slot.place) || slot.node.type === "text") continue;
      if (!slot.key || !isTwin(slot)) {
        twins(slot.children);
        continue;
      }
      const next = candidates.get(slot.key)!.find((candidate) => subtree(candidate).every((each) => !used.has(each)));
      if (next) {
        claim(next);
        replacement.set(slot.place, next);
      } else {
        // No source twin left whole: its nodes are matched one by one, and
        // the ids a kept node holds are dropped from it below.
        twins(slot.children);
      }
    }
  };
  // Last, nodes inside twins that had no source twin left whole, by the same rule.
  const decide = (slots: Slot[]) => {
    for (const slot of slots) {
      if (!slot.key || exactPlaces.has(slot.place) || replacement.has(slot.place)) continue;
      // Twins are the twin pass's; its nodes there are matched one by one.
      if (isTwin(slot)) {
        decide(slot.children);
        continue;
      }
      // Only a source node none of whose nodes stands elsewhere already.
      const free = (candidates.get(slot.key) ?? []).filter((candidate) => subtree(candidate).every((each) => !used.has(each)));
      if (free.length > 0) {
        if (new Set(free.map(withoutIdentity)).size > 1) throw new Error(AMBIGUOUS_EDIT);
        claim(free[0]!);
        replacement.set(slot.place, free[0]!);
        continue;
      }
      decide(slot.children);
    }
  };
  twins(writtenSlots);
  decide(writtenSlots);

  // Every id a kept source node holds; no rebuilt node may hold one too.
  const keptIds = new Set([...claimed].flatMap(identitiesOf));
  const build = (slot: Slot): AdfNode => {
    if (replacement.has(slot.place)) return replacement.get(slot.place)!;
    if (exactPlaces.has(slot.place) || slot.node.type === "text") return slot.node;
    let node = slot.node;
    const clashing = identitiesOf(node).filter((id) => keptIds.has(id));
    if (clashing.length > 0) {
      const attrs = { ...node.attrs };
      for (const id of clashing) delete attrs[id.slice(0, id.indexOf("="))];
      node = { ...node, attrs };
    }
    if (slot.children.length === 0) return node;
    const content = slot.children.map(build);
    return content.every((child, at) => child === slot.children[at]!.node) ? node : { ...node, content };
  };
  return writtenSlots.map(build);
}

/**
 * Pairs the blocks a write rebuilt with the source blocks it did not keep as
 * they were, by their Markdown, as `pairChildren` does inside a block.
 */
function pairTopLevel(content: AdfNode[], parts: AdfNode[], written: AdfNode[], context: AdfImageContext) {
  const sourceNodes = new Set(content);
  const writtenNodes = new Set(written);
  return pairChildren(
    parts.filter((node) => !writtenNodes.has(node)),
    written.filter((node) => !sourceNodes.has(node)),
    context,
  );
}

/**
 * The written top-level blocks, each rebuilt one with what its source block
 * keeps. `content` is the source document's, `parts` its blocks that read as
 * Markdown.
 */
export function reconcileDocument(
  content: AdfNode[],
  parts: AdfNode[],
  written: AdfNode[],
  context: AdfImageContext,
): AdfNode[] {
  const replacement = new Map<AdfNode, AdfNode>();
  for (const pair of pairTopLevel(content, parts, written, context)) {
    replacement.set(pair.written, pair.same ? pair.source : reconcileNode(pair.source, pair.written, context));
  }
  return written.map((node) => replacement.get(node) ?? node);
}
