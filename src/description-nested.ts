import { adfToMarkdown, type AdfImageContext, type AdfNode } from "./adf-markdown.js";

// What keeps a description's untouched parts exactly as they were below the
// top level. When the write rebuilds a block from Markdown, its children are
// aligned with the source block's children by their Markdown: a child that
// reads the same is the source child itself, ids and attributes included, and
// a changed child that lines up with one source child takes over that child's
// ids and the attributes Markdown has no place for, down to the mentions, inline
// files and smart links of its text. The same alignment checks the result.

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

/** A node as JSON without the ids that only name it. */
export function withoutIds(node: unknown): string {
  return JSON.stringify(node, (key, value) => (key === "localId" ? undefined : value));
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

/** The neutral attributes a node must keep through a rebuild. */
function neutralAttributes(node: AdfNode) {
  return Object.entries(node.attrs ?? {}).filter(([name, value]) => isNeutralAttribute(node.type, name, value));
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
    if (uncertain && group.length > 1 && new Set(group.map(withoutIds)).size > 1) throw new Error(AMBIGUOUS_EDIT);
  });

  const pairs: Pair[] = [];
  let sourceAt = 0;
  let writtenAt = 0;
  const pairRun = (sourceEnd: number, writtenEnd: number) => {
    const sourceRun = sources.slice(sourceAt, sourceEnd);
    const writtenRun = written.slice(writtenAt, writtenEnd);
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
 * Pairs the inline atoms of a rebuilt run of text with the source's: by id or
 * address, and hard breaks in order when there are as many.
 */
function pairAtoms(sources: AdfNode[], written: AdfNode[], context: AdfImageContext): Pair[] {
  const pairs: Pair[] = [];
  const used = new Set<AdfNode>();
  for (const node of written) {
    const identity = atomIdentity(node);
    if (!identity) continue;
    const source = sources.find((candidate) => !used.has(candidate) && atomIdentity(candidate) === identity);
    if (!source) continue;
    used.add(source);
    pairs.push({ source, written: node, same: keyOf(source, context) === keyOf(node, context) });
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

/**
 * The source nodes, below the top level, that a write should have kept as
 * they were and did not: a child that reads the same as its aligned source
 * child must be that child, deep-equal, and a changed child aligned with one
 * must keep its ids and neutral attributes.
 */
export function rebuiltNested(
  content: AdfNode[],
  parts: AdfNode[],
  written: AdfNode[],
  context: AdfImageContext,
): AdfNode[] {
  const rebuilt: AdfNode[] = [];
  const check = (source: AdfNode, result: AdfNode) => {
    if (source.type !== result.type) return;
    if (neutralAttributes(source).some(([name, value]) => result.attrs?.[name] !== value)) rebuilt.push(source);
    const children = childrenOf(result);
    const pairs = INLINE_CONTAINERS.has(String(result.type))
      ? pairAtoms(childrenOf(source), children, context)
      : pairChildren(childrenOf(source), children, context);
    for (const pair of pairs) {
      if (pair.same) {
        if (JSON.stringify(pair.source) !== JSON.stringify(pair.written)) rebuilt.push(pair.source);
      } else {
        check(pair.source, pair.written);
      }
    }
  };
  for (const pair of pairTopLevel(content, parts, written, context)) {
    if (pair.same) {
      if (JSON.stringify(pair.source) !== JSON.stringify(pair.written)) rebuilt.push(pair.source);
    } else {
      check(pair.source, pair.written);
    }
  }
  return rebuilt;
}
