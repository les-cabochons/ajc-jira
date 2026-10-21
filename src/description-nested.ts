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
    } else if (suffix[(i + 1) * width + j]! >= suffix[i * width + j + 1]!) {
      i += 1;
    } else {
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
function pairChildren(sources: AdfNode[], written: AdfNode[], context: AdfImageContext): Pair[] {
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
  const pairs = INLINE_CONTAINERS.has(String(rebuilt.type))
    ? pairAtoms(childrenOf(source), written, context)
    : pairChildren(childrenOf(source), written, context);
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
 * Markdown, whatever its ancestors are. A node with no Markdown of its own is
 * keyed by its kind and its neighbours: a hard break by the lines on each
 * side, an empty block by the nearest blocks with Markdown on each side.
 */
function slotsOf(siblings: AdfNode[], inline: boolean, place: string, context: AdfImageContext): Slot[] {
  const markdowns = siblings.map((node) => (node.type === "text" ? "-" : keyOf(node, context)));
  const isBoundary = (at: number, type: unknown) => siblings[at]!.type === type && markdowns[at] === "";
  return siblings.map((node, index) => {
    const type = String(node.type);
    let key: string | undefined;
    if (type !== "text") {
      const markdown = markdowns[index]!;
      if (markdown !== "") {
        key = `${type}\u0000${markdown}`;
      } else if (inline) {
        let start = index;
        while (start > 0 && !isBoundary(start - 1, node.type)) start -= 1;
        let end = index + 1;
        while (end < siblings.length && !isBoundary(end, node.type)) end += 1;
        key = `${type}\u0000\u0001${runMarkdown(siblings.slice(start, index), true, context)}\u0001${runMarkdown(siblings.slice(index + 1, end), true, context)}`;
      } else {
        const before = markdowns.slice(0, index).filter((each) => each !== "").at(-1) ?? "";
        const after = markdowns.slice(index + 1).find((each) => each !== "") ?? "";
        key = `${type}\u0000\u0001${before}\u0001${after}`;
      }
    }
    const at = `${place}/${index}`;
    return { node, key, place: at, children: slotsOf(childrenOf(node), INLINE_CONTAINERS.has(type), at, context) };
  });
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
  index(slotsOf(source, false, "", context));
  const writtenSlots = slotsOf(written, false, "", context);

  const used = new Set<AdfNode>();
  const claim = (node: AdfNode) => subtree(node).forEach((each) => used.add(each));
  const twinKeys = new Set(
    [...candidates].filter(([, nodes]) => nodes.length > 1 && new Set(nodes.map(withoutIdentity)).size === 1).map(([key]) => key),
  );
  const isTwin = (slot: Slot) =>
    slot.key !== undefined && twinKeys.has(slot.key) && withoutIdentity(slot.node) === withoutIdentity(candidates.get(slot.key)![0]);
  /** What each place becomes: a source node, or a copy without ids. */
  const replacement = new Map<string, AdfNode>();
  const exactPlaces = new Set<string>();

  // Exact copies first, outermost first across the whole document, so a block
  // is claimed before the atoms inside another block are.
  for (let level = writtenSlots; level.length > 0; ) {
    const deeper: Slot[] = [];
    for (const slot of level) {
      if (!slot.key || isTwin(slot)) {
        if (!slot.key && slot.node.type !== "text") deeper.push(...slot.children);
        continue;
      }
      const json = JSON.stringify(slot.node);
      const match = (candidates.get(slot.key) ?? []).find(
        (candidate) => subtree(candidate).every((each) => !used.has(each)) && JSON.stringify(candidate) === json,
      );
      if (match) {
        claim(match);
        exactPlaces.add(slot.place);
        continue;
      }
      deeper.push(...slot.children);
    }
    level = deeper;
  }

  // Twins that differ only in ids: each written twin, in document order and
  // outermost first across the document, is the earliest source twin not yet
  // written. A twin past the source's count is the user's copy, with no ids.
  for (let level = writtenSlots; level.length > 0; ) {
    const deeper: Slot[] = [];
    for (const slot of level) {
      if (!slot.key || exactPlaces.has(slot.place)) continue;
      if (!isTwin(slot)) {
        deeper.push(...slot.children);
        continue;
      }
      const next = candidates.get(slot.key)!.find((candidate) => subtree(candidate).every((each) => !used.has(each)));
      if (next) claim(next);
      replacement.set(slot.place, next ?? (JSON.parse(withoutIdentity(slot.node)) as AdfNode));
    }
    level = deeper;
  }

  // Then any other node that reads as a source node not yet written.
  const decide = (slots: Slot[]) => {
    for (const slot of slots) {
      if (!slot.key || exactPlaces.has(slot.place) || replacement.has(slot.place)) continue;
      const free = (candidates.get(slot.key) ?? []).filter((candidate) => !used.has(candidate));
      if (free.length > 0) {
        if (new Set(free.map(withoutIdentity)).size > 1) throw new Error(AMBIGUOUS_EDIT);
        claim(free[0]!);
        replacement.set(slot.place, free[0]!);
        continue;
      }
      decide(slot.children);
    }
  };
  decide(writtenSlots);

  // Every id a kept source node holds; no rebuilt node may hold one too.
  const keptIds = new Set([...used].flatMap(identitiesOf));
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
