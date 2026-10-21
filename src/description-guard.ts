import { adfToMarkdown, type AdfImageContext, type AdfNode } from "./adf-markdown.js";
import { AMBIGUOUS_EDIT, documentOf } from "./description-nested.js";

// Checks a write against its source, independently of how the patch aligned
// them: it reads both documents and compares what they hold, node by node, at
// every depth. Each node is keyed by where it stands (the kinds of its
// ancestors), its kind and its Markdown. A written node whose key the source
// has must be one of those source nodes, deep-equal, ids and attributes
// included; one whose key is new is the user's change, and may carry ids and
// attributes only from a source node that did not survive.

/** Attributes the writer never gives a node of each kind, which a changed node can only have from its source. */
const CARRIED_ATTRIBUTES: Record<string, string[]> = {
  mention: ["accessLevel", "userType"],
  codeBlock: ["uniqueId"],
  table: ["width", "displayMode"],
  tableCell: ["colspan", "rowspan"],
  tableHeader: ["colspan", "rowspan"],
  hardBreak: ["text"],
};

type Entry = { node: AdfNode; key: string; json: string };

function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? (node.content as AdfNode[]) : [];
}

/** Every node but text, at every depth, with its key. Nodes with no Markdown, as empty lines, have none. */
function inventory(content: AdfNode[], context: AdfImageContext): Entry[] {
  const entries: Entry[] = [];
  const walk = (node: AdfNode, path: string) => {
    const type = String(node.type);
    if (type !== "text") {
      const markdown = adfToMarkdown(documentOf(node), context) ?? "";
      if (markdown !== "") entries.push({ node, key: `${path}>${type}\u0000${markdown}`, json: JSON.stringify(node) });
    }
    for (const child of childrenOf(node)) walk(child, `${path}>${type}`);
  };
  for (const node of content) walk(node, "doc");
  return entries;
}

/** Every node in `content`, at every depth. */
function everyNode(content: AdfNode[]): AdfNode[] {
  return content.flatMap((node) => [node, ...everyNode(childrenOf(node))]);
}

function localIdOf(node: AdfNode) {
  const id = node.attrs?.localId;
  return typeof id === "string" && id !== "" ? id : undefined;
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
 * and those source nodes differ, so which survived cannot be told.
 */
export function checkPreservation(
  source: { content: unknown[] },
  written: { content: unknown[] },
  context: AdfImageContext,
): PreservationReport {
  const sourceEntries = inventory(source.content as AdfNode[], context);
  const writtenEntries = inventory(written.content as AdfNode[], context);

  // Deep-equal nodes, outermost first: a written node equal to a source node
  // with its key is that node, and everything under both survived with it,
  // so it takes no part below. Deep-equal nodes are interchangeable, so this
  // is a largest matching.
  const sourceByKey = new Map<string, Entry[]>();
  for (const entry of sourceEntries) sourceByKey.set(entry.key, [...(sourceByKey.get(entry.key) ?? []), entry]);
  const matched = new Set<Entry>();
  const covered = new Set<AdfNode>();
  for (const entry of writtenEntries) {
    if (covered.has(entry.node)) continue;
    const twin = (sourceByKey.get(entry.key) ?? []).find(
      (candidate) => !matched.has(candidate) && !covered.has(candidate.node) && candidate.json === entry.json,
    );
    if (!twin) continue;
    matched.add(twin).add(entry);
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
  for (const [key, writtenNodes] of writtens) {
    const sourceNodes = sources.get(key) ?? [];
    if (writtenNodes.length < sourceNodes.length && new Set(sourceNodes.map((entry) => entry.json)).size > 1) {
      throw new Error(AMBIGUOUS_EDIT);
    }
    const unmatched = writtenNodes.filter((entry) => !matched.has(entry));
    const left = sourceNodes.filter((entry) => !matched.has(entry));
    // A kept node written otherwise.
    if (unmatched.length > 0 && left.length > 0) rebuilt.push(...left.map((entry) => entry.node));
    freeSources.push(...left);
    freeWritten.push(...unmatched);
  }
  for (const [key, sourceNodes] of sources) {
    if (!writtens.has(key)) freeSources.push(...sourceNodes);
  }

  // A changed node's ids and carried attributes come from a source node of
  // its kind that did not survive.
  const sourceIds = new Set(sourceEntries.map((entry) => localIdOf(entry.node)).filter(Boolean));
  for (const entry of freeWritten) {
    const attrs = entry.node.attrs ?? {};
    const carried = (CARRIED_ATTRIBUTES[String(entry.node.type)] ?? []).filter((name) => name in attrs);
    const id = localIdOf(entry.node);
    const carriesId = id !== undefined && sourceIds.has(id);
    if (carried.length === 0 && !carriesId) continue;
    const donor = freeSources.some(
      (candidate) =>
        candidate.node.type === entry.node.type &&
        carried.every((name) => candidate.node.attrs?.[name] === attrs[name]) &&
        (!carriesId || localIdOf(candidate.node) === id),
    );
    if (!donor) invalid.push(entry.node);
  }

  // No id is written more times than the source held it, empty lines included.
  const count = (nodes: AdfNode[]) => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const id = localIdOf(node);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  };
  const sourceCounts = count(everyNode(source.content as AdfNode[]));
  const writtenNodes = everyNode(written.content as AdfNode[]);
  for (const [id, times] of count(writtenNodes)) {
    if (times > Math.max(1, sourceCounts.get(id) ?? 0)) {
      invalid.push(...writtenNodes.filter((node) => localIdOf(node) === id));
    }
  }
  return { rebuilt: [...new Set(rebuilt)], invalid: [...new Set(invalid)] };
}
