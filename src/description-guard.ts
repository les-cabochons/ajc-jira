import { adfToMarkdown, type AdfImageContext, type AdfNode } from "./adf-markdown.js";
import { AMBIGUOUS_EDIT, documentOf } from "./description-nested.js";

// Checks a write against its source, independently of how the patch aligned
// them, by conservation: every source node the edit kept must still be in the
// written document, as it was. Each node is keyed by its kind and its own
// Markdown, not by its ancestors, so a mention stays the same mention when
// its paragraph becomes a heading. A node with no Markdown of its own, as a
// hard break or an empty paragraph, is keyed by its kind and the content
// between it and its neighbours of the same kind: a hard break is the break
// between two lines, which is what a reader sees of it, so it stays the same
// break while those two lines stay.
//
// For each key that still occurs in the written document, every source node
// with that key must be a distinct written node, deep-equal, ids included.
// When fewer written nodes carry the key, the source nodes must be twins that
// differ only in ids, and the earliest of them are the ones kept; otherwise
// which survived cannot be told. A key that no longer occurs was changed or
// deleted by the user. A changed node may carry ids and attributes only from
// a source node of its kind that did not survive, and no id is written twice.

/** Attributes the writer never gives a node of each kind, which a changed node can only have from its source. */
const CARRIED_ATTRIBUTES: Record<string, string[]> = {
  mention: ["accessLevel", "userType"],
  codeBlock: ["uniqueId"],
  table: ["width", "displayMode"],
  tableCell: ["colspan", "rowspan"],
  tableHeader: ["colspan", "rowspan"],
  hardBreak: ["text"],
};

/** Attributes that only name a node: neither content nor how it looks. */
const IDENTITY_ATTRIBUTES = ["localId", "uniqueId"];

/** Nodes whose content is text and inline atoms. */
const INLINE_CONTAINERS = new Set(["paragraph", "heading", "taskItem", "decisionItem", "caption"]);

type Entry = { node: AdfNode; key: string; json: string; order: number; depth: number };

function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content as AdfNode[]) : [];
}

/** Every node in `content`, at every depth. */
function everyNode(content: AdfNode[]): AdfNode[] {
  return content.flatMap((node) => [node, ...everyNode(childrenOf(node))]);
}

/** A node as JSON without its ids, at every depth: attributes left empty count as none. */
function withoutIdentity(node: AdfNode) {
  return JSON.stringify(node, (key, value) => {
    if (IDENTITY_ATTRIBUTES.includes(key)) return undefined;
    if (key === "attrs" && value && typeof value === "object" && Object.keys(value).every((name) => IDENTITY_ATTRIBUTES.includes(name))) {
      return undefined;
    }
    return value;
  });
}

/** The Markdown of a run of siblings, inline or blocks. */
function runMarkdown(siblings: AdfNode[], inline: boolean, context: AdfImageContext) {
  const content = inline ? [{ type: "paragraph", content: siblings }] : siblings;
  return adfToMarkdown({ type: "doc", version: 1, content }, context) ?? "";
}

/** Every node but text, at every depth, in document order, with its key. */
function inventory(content: AdfNode[], context: AdfImageContext): Entry[] {
  const entries: Entry[] = [];
  const walk = (siblings: AdfNode[], inline: boolean, depth: number) => {
    const markdowns = siblings.map((node) => (node.type === "text" ? "-" : (adfToMarkdown(documentOf(node), context) ?? "")));
    // Another node of this kind with no Markdown of its own.
    const isBoundary = (at: number, type: unknown) => siblings[at]!.type === type && markdowns[at] === "";
    siblings.forEach((node, index) => {
      const type = String(node.type);
      if (type !== "text") {
        const markdown = markdowns[index]!;
        let key = `${type}\u0000${markdown}`;
        if (markdown === "" && inline) {
          // A hard break: the lines on each side, up to the next breaks.
          let start = index;
          while (start > 0 && !isBoundary(start - 1, node.type)) start -= 1;
          let end = index + 1;
          while (end < siblings.length && !isBoundary(end, node.type)) end += 1;
          key = `${type}\u0000\u0001${runMarkdown(siblings.slice(start, index), true, context)}\u0001${runMarkdown(siblings.slice(index + 1, end), true, context)}`;
        } else if (markdown === "") {
          // An empty block: the nearest blocks with Markdown on each side.
          const before = markdowns.slice(0, index).filter((each) => each !== "").at(-1) ?? "";
          const after = markdowns.slice(index + 1).find((each) => each !== "") ?? "";
          key = `${type}\u0000\u0001${before}\u0001${after}`;
        }
        entries.push({ node, key, json: JSON.stringify(node), order: entries.length, depth });
      }
      walk(childrenOf(node), INLINE_CONTAINERS.has(type), depth + 1);
    });
  };
  walk(content, false, 0);
  return entries;
}

function identitiesOf(node: AdfNode) {
  return IDENTITY_ATTRIBUTES.flatMap((name) => {
    const value = node.attrs?.[name];
    return typeof value === "string" && value !== "" ? [`${name}=${value}`] : [];
  });
}

export interface PreservationReport {
  /** Source nodes the user kept that the write holds otherwise: allowed only by `allowedLoss`. */
  rebuilt: AdfNode[];
  /** Written nodes with ids or attributes they could not have: never allowed. */
  invalid: AdfNode[];
}

/**
 * What a written description fails to keep of its source. Throws
 * `AMBIGUOUS_EDIT` when fewer nodes with a key survive than the source held,
 * and those source nodes differ beyond ids, so which survived cannot be told.
 */
export function checkPreservation(
  source: { content: unknown[] },
  written: { content: unknown[] },
  context: AdfImageContext,
): PreservationReport {
  const sourceEntries = inventory(source.content as AdfNode[], context);
  const writtenEntries = inventory(written.content as AdfNode[], context);

  // Deep-equal nodes, outermost first: a written node equal to a source node
  // with its key is that node, and everything under both survived with it, so
  // it takes no part below.
  const sourceByKey = new Map<string, Entry[]>();
  for (const entry of sourceEntries) sourceByKey.set(entry.key, [...(sourceByKey.get(entry.key) ?? []), entry]);
  const matched = new Map<Entry, Entry>();
  const matchedSources = new Set<AdfNode>();
  const covered = new Set<AdfNode>();
  for (const entry of [...writtenEntries].sort((left, right) => left.depth - right.depth || left.order - right.order)) {
    if (covered.has(entry.node)) continue;
    const twin = (sourceByKey.get(entry.key) ?? []).find(
      (candidate) =>
        !matched.has(candidate) &&
        !covered.has(candidate.node) &&
        candidate.json === entry.json &&
        everyNode(childrenOf(candidate.node)).every((each) => !matchedSources.has(each)),
    );
    if (!twin) continue;
    matched.set(twin, entry).set(entry, twin);
    matchedSources.add(twin.node);
    for (const node of [twin.node, entry.node]) everyNode(childrenOf(node)).forEach((each) => covered.add(each));
  }

  const byKey = (entries: Entry[]) => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (!covered.has(entry.node)) map.set(entry.key, [...(map.get(entry.key) ?? []), entry]);
    }
    return map;
  };
  const sources = byKey(sourceEntries);
  const writtens = byKey(writtenEntries);

  const rebuilt: AdfNode[] = [];
  const invalid: AdfNode[] = [];
  const freeSources: Entry[] = [];
  const freeWritten: Entry[] = [];
  for (const [key, sourceNodes] of sources) {
    const writtenNodes = writtens.get(key) ?? [];
    // The key is gone: the user changed or deleted these.
    if (writtenNodes.length === 0) {
      freeSources.push(...sourceNodes);
      continue;
    }
    const unaccounted = sourceNodes.filter((entry) => !matched.has(entry));
    if (writtenNodes.length < sourceNodes.length) {
      // Fewer left: only twins that differ in nothing but ids, the earliest kept.
      if (new Set(sourceNodes.map((entry) => withoutIdentity(entry.node))).size > 1) throw new Error(AMBIGUOUS_EDIT);
      // A twin not written itself but with nodes under it written elsewhere
      // was changed by the user, as a list whose items went into an edited one.
      const changed = (entry: Entry) =>
        !matched.has(entry) && everyNode(childrenOf(entry.node)).some((each) => matchedSources.has(each));
      freeSources.push(...sourceNodes.filter(changed));
      const eligible = sourceNodes.filter((entry) => !changed(entry));
      const kept = eligible.slice(0, writtenNodes.length);
      const later = eligible.slice(writtenNodes.length);
      rebuilt.push(...kept.filter((entry) => !matched.has(entry)).map((entry) => entry.node));
      freeSources.push(...later.filter((entry) => !matched.has(entry)));
      // A later twin kept in place of an earlier one is not the rule.
      invalid.push(...later.filter((entry) => matched.has(entry)).map((entry) => matched.get(entry)!.node));
    } else {
      // Every source node with the key must be written as it was.
      rebuilt.push(...unaccounted.map((entry) => entry.node));
    }
  }
  for (const writtenNodes of writtens.values()) {
    // Written nodes no source node accounts for: the user's change or copy.
    freeWritten.push(...writtenNodes.filter((entry) => !matched.has(entry)));
  }

  // A changed node's ids and carried attributes come from a source node of
  // its kind that did not survive.
  const sourceIds = new Set(sourceEntries.flatMap((entry) => identitiesOf(entry.node)));
  for (const entry of freeWritten) {
    const attrs = entry.node.attrs ?? {};
    const carried = (CARRIED_ATTRIBUTES[String(entry.node.type)] ?? []).filter((name) => name in attrs);
    const ids = identitiesOf(entry.node).filter((id) => sourceIds.has(id));
    if (carried.length === 0 && ids.length === 0) continue;
    const donor = freeSources.some(
      (candidate) =>
        candidate.node.type === entry.node.type &&
        carried.every((name) => candidate.node.attrs?.[name] === attrs[name]) &&
        ids.every((id) => identitiesOf(candidate.node).includes(id)),
    );
    if (!donor) invalid.push(entry.node);
  }

  // No id is written more times than the source held it.
  const count = (nodes: AdfNode[]) => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      for (const id of identitiesOf(node)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  };
  const sourceCounts = count(everyNode(source.content as AdfNode[]));
  const writtenNodes = everyNode(written.content as AdfNode[]);
  for (const [id, times] of count(writtenNodes)) {
    if (times > Math.max(1, sourceCounts.get(id) ?? 0)) {
      invalid.push(...writtenNodes.filter((node) => identitiesOf(node).includes(id)));
    }
  }
  return { rebuilt: [...new Set(rebuilt)], invalid: [...new Set(invalid)] };
}
