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
 * ambiguous. Hard breaks pair in order when there are as many.
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
  const sourceBreaks = sources.filter((node) => node.type === "hardBreak");
  const writtenBreaks = written.filter((node) => node.type === "hardBreak");
  if (sourceBreaks.length === writtenBreaks.length) {
    sourceBreaks.forEach((node, index) => pairs.push({ source: node, written: writtenBreaks[index]!, same: true }));
  }
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

/** A node as JSON without its ids, at every depth. */
export function withoutIdentity(node: unknown): string {
  return JSON.stringify(node, (key, value) => (IDENTITY_ATTRIBUTES.has(key) ? undefined : value));
}

function nodeKey(node: AdfNode, path: string, context: AdfImageContext) {
  return `${path}>${String(node.type)}\u0000${keyOf(node, context)}`;
}

/** A node and every node under it. */
function subtree(node: AdfNode): AdfNode[] {
  return [node, ...childrenOf(node).flatMap(subtree)];
}

/**
 * The last pass of a rebuild: any written node that reads the same, where it
 * stands, as a source node the write does not hold yet becomes that source
 * node, ids and attributes included, wherever the alignment lost track of it,
 * as a mention in two paragraphs the user joined. Nodes already written
 * exactly are claimed first. When the source nodes it could be differ, the
 * edit is ambiguous. Ids a rebuilt node took from a node restored here are
 * dropped from it.
 */
export function restoreKeptNodes(source: AdfNode[], written: AdfNode[], context: AdfImageContext): AdfNode[] {
  const candidates = new Map<string, AdfNode[]>();
  const index = (node: AdfNode, path: string) => {
    if (node.type !== "text" && keyOf(node, context) !== "") {
      const key = nodeKey(node, path, context);
      candidates.set(key, [...(candidates.get(key) ?? []), node]);
    }
    for (const child of childrenOf(node)) index(child, `${path}>${String(node.type)}`);
  };
  source.forEach((node) => index(node, "doc"));
  const used = new Set<AdfNode>();
  const claim = (node: AdfNode) => subtree(node).forEach((each) => used.add(each));
  const writtenExactly = new Set<AdfNode>();
  // Keys held by twins that differ only in ids, which are kept in order below.
  const twinKeys = new Set(
    [...candidates].filter(([, nodes]) => nodes.length > 1 && new Set(nodes.map(withoutIdentity)).size === 1).map(([key]) => key),
  );
  const isTwin = (node: AdfNode, key: string) =>
    twinKeys.has(key) && withoutIdentity(node) === withoutIdentity(candidates.get(key)![0]);

  // Exact copies first, outermost first.
  const exact = (node: AdfNode, path: string) => {
    if (node.type !== "text") {
      if (isTwin(node, nodeKey(node, path, context))) return;
      const match = (candidates.get(nodeKey(node, path, context)) ?? []).find(
        (candidate) => !used.has(candidate) && JSON.stringify(candidate) === JSON.stringify(node),
      );
      if (match) {
        claim(match);
        writtenExactly.add(node);
        return;
      }
    }
    for (const child of childrenOf(node)) exact(child, `${path}>${String(node.type)}`);
  };
  written.forEach((node) => exact(node, "doc"));

  // Twins that differ only in ids: each written twin, in document order, is
  // the earliest source twin not yet written. A twin past the source's count
  // is the user's copy, and takes no id.
  const restored: AdfNode[] = [];
  const replacement = new Map<AdfNode, AdfNode>();
  // Outermost first across the whole document, so a twin block takes its
  // source twin before the atoms inside another block are given theirs.
  for (let level = written.map((node) => ({ node, path: "doc" })); level.length > 0; ) {
    const deeper: { node: AdfNode; path: string }[] = [];
    for (const { node, path } of level) {
      if (node.type === "text" || writtenExactly.has(node)) continue;
      const key = nodeKey(node, path, context);
      if (!isTwin(node, key)) {
        deeper.push(...childrenOf(node).map((child) => ({ node: child, path: `${path}>${String(node.type)}` })));
        continue;
      }
      const next = candidates.get(key)!.find((candidate) => subtree(candidate).every((each) => !used.has(each)));
      if (next) {
        claim(next);
        restored.push(next);
        replacement.set(node, next);
      } else {
        replacement.set(node, JSON.parse(withoutIdentity(node)) as AdfNode);
      }
    }
    level = deeper;
  }

  const restore = (node: AdfNode, path: string): AdfNode => {
    if (replacement.has(node)) return replacement.get(node)!;
    if (node.type === "text" || writtenExactly.has(node)) return node;
    const free =
      keyOf(node, context) === ""
        ? []
        : (candidates.get(nodeKey(node, path, context)) ?? []).filter((candidate) => !used.has(candidate));
    if (free.length > 0) {
      if (new Set(free.map((candidate) => JSON.stringify(candidate))).size > 1) throw new Error(AMBIGUOUS_EDIT);
      claim(free[0]!);
      restored.push(free[0]!);
      return free[0]!;
    }
    const children = childrenOf(node);
    if (children.length === 0) return node;
    const content = children.map((child) => restore(child, `${path}>${String(node.type)}`));
    return content.every((child, at) => child === children[at]) ? node : { ...node, content };
  };
  let result = written.map((node) => restore(node, "doc"));

  // A rebuilt node keeps no id a restored node holds, even where a source
  // node it reused, such as a hard break, sits inside the restored one too.
  const restoredIds = new Set(
    restored.flatMap(subtree).map((node) => node.attrs?.localId).filter((id) => typeof id === "string"),
  );
  if (restoredIds.size > 0) {
    const restoredRoots = new Set(restored);
    const dropIds = (node: AdfNode): AdfNode => {
      if (restoredRoots.has(node)) return node;
      let next = node;
      const id = node.attrs?.localId;
      if (typeof id === "string" && restoredIds.has(id)) {
        const { localId: _dropped, ...attrs } = node.attrs!;
        next = { ...node, attrs };
      }
      const children = childrenOf(next);
      if (children.length === 0) return next;
      const content = children.map(dropIds);
      return content.every((child, at) => child === children[at]) ? next : { ...next, content };
    };
    result = result.map(dropIds);
  }
  return result;
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
