import { adfToMarkdown, type AdfImageContext, type AdfNode } from "./adf-markdown.js";
import { AMBIGUOUS_EDIT, documentOf } from "./description-nested.js";

// Checks a write against its source, independently of how the patch aligned
// them: none of the patch's alignment or pairing is used here.
//
// First by context, from the document down. In each pair of blocks, source
// and written, children that read the same are lined up in order, and the
// changed ones between them pair in order, or by kind when a kind occurs once
// on each side. A kept child must be written as it was. Nodes with no
// Markdown of their own are told by their boundaries: a hard break by the
// lines on each side, an empty block by the blocks on each side. One whose
// line or block on either side is kept, and still has such a node on that
// side, is that node; the rest pair in order when as many are left on each
// side; a source one left over that carries an id or attributes is lost. A
// mention, inline file or smart link is resolved by the line or the block
// that holds it.
//
// Then by conservation, for what context left unresolved, as nodes moved to
// another place or kind. Each node is keyed by its kind and its own Markdown,
// not its ancestors. For every key the written document still holds, every
// source node with that key must be written, deep-equal, ids included; when
// fewer are written, the source nodes must be twins that differ only in ids,
// and the earliest are the ones kept, or which survived cannot be told. A key
// no longer held was changed or deleted by the user. A changed node may carry
// ids and attributes only from a source node of its kind that did not
// survive, and no id is written twice.

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

/** Past this many pairs, a diff costs too much. */
const MAX_DIFF_CELLS = 4_000_000;

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

function identitiesOf(node: AdfNode) {
  return IDENTITY_ATTRIBUTES.flatMap((name) => {
    const value = node.attrs?.[name];
    return typeof value === "string" && value !== "" ? [`${name}=${value}`] : [];
  });
}

/** Whether a node with no Markdown carries more than a plain one: an id or any attribute but a break's own newline. */
function carriesMore(node: AdfNode) {
  return Object.entries(node.attrs ?? {}).some(([name, value]) => !(node.type === "hardBreak" && name === "text" && value === "\n"));
}

/**
 * A longest common subsequence of two lists of keys: for each item of the
 * first, the item of the second it stays as, or -1. Ties keep earlier items.
 */
function longestCommon(before: string[], after: string[]): number[] {
  const n = before.length;
  const m = after.length;
  const match = new Array<number>(n).fill(-1);
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return match;
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
      // On a tie, an earlier source item keeps its chance to match.
      j += 1;
    }
  }
  return match;
}

/**
 * Lines up two lists: exact copies first, by their whole JSON, then, between
 * those, items that read the same. Exact copies come first so that blocks
 * moved past their twins stay with their own copies.
 */
function lineUp(before: AdfNode[], after: AdfNode[], readAs: (node: AdfNode) => string): number[] {
  const json = (node: AdfNode) => JSON.stringify(node);
  const match = longestCommon(before.map(json), after.map(json));
  let beforeAt = 0;
  let afterAt = 0;
  const fill = (beforeEnd: number, afterEnd: number) => {
    const inner = longestCommon(before.slice(beforeAt, beforeEnd).map(readAs), after.slice(afterAt, afterEnd).map(readAs));
    inner.forEach((at, index) => {
      if (at >= 0) match[beforeAt + index] = afterAt + at;
    });
  };
  for (let index = 0; index < before.length; index += 1) {
    if (match[index]! < 0) continue;
    fill(index, match[index]!);
    beforeAt = index + 1;
    afterAt = match[index]! + 1;
  }
  fill(before.length, after.length);
  return match;
}

/** Lines up two runs of text's lines, by `lineUp`. */
function lineUpLines(before: AdfNode[][], after: AdfNode[][], readAs: (nodes: AdfNode[]) => string): number[] {
  const wrap = (nodes: AdfNode[]): AdfNode => ({ type: "line", content: nodes });
  return lineUp(before.map(wrap), after.map(wrap), (node) => readAs(childrenOf(node)));
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
  const markdownOf = (node: AdfNode) => adfToMarkdown(documentOf(node), context) ?? "";
  const lineOf = (nodes: AdfNode[]) =>
    adfToMarkdown({ type: "doc", version: 1, content: [{ type: "paragraph", content: nodes }] }, context) ?? "";

  const rebuilt: AdfNode[] = [];
  const invalid: AdfNode[] = [];
  // Nodes context accounted for, on each side, and the changed blocks it paired.
  const resolvedSources = new Set<AdfNode>();
  const resolvedWritten = new Set<AdfNode>();
  const changedPairs: { source: AdfNode; written: AdfNode }[] = [];
  // Source nodes context found a written place for, deep-equal or not.
  const placedSources = new Set<AdfNode>();

  // Keys held by twins that differ only in ids, anywhere in the source: such
  // a node is left to conservation, which keeps the earliest twins, in order.
  const twinGroups = new Map<string, AdfNode[]>();
  for (const node of everyNode(source.content as AdfNode[])) {
    const markdown = node.type === "text" ? "" : markdownOf(node);
    if (markdown === "") continue;
    const key = `${String(node.type)}\u0000${markdown}`;
    twinGroups.set(key, [...(twinGroups.get(key) ?? []), node]);
  }
  const isIdTwin = (node: AdfNode) => {
    const group = twinGroups.get(`${String(node.type)}\u0000${markdownOf(node)}`) ?? [];
    return group.length > 1 && new Set(group.map(withoutIdentity)).size === 1;
  };

  /** A source node and the written node it must be, deep-equal. */
  const keep = (sourceNode: AdfNode, writtenNode: AdfNode) => {
    if (isIdTwin(sourceNode)) return;
    placedSources.add(sourceNode);
    everyNode([sourceNode]).forEach((node) => resolvedSources.add(node));
    everyNode([writtenNode]).forEach((node) => resolvedWritten.add(node));
    if (JSON.stringify(sourceNode) !== JSON.stringify(writtenNode)) rebuilt.push(sourceNode);
  };
  /** A source node with no Markdown left without its written place: lost if it carries anything. */
  const leftOver = (sourceNode: AdfNode) => {
    resolvedSources.add(sourceNode);
    if (carriesMore(sourceNode)) rebuilt.push(sourceNode);
  };

  /** Pairs the empty nodes of two runs by their boundaries, then in order. */
  const pairEmpty = (
    sourceGaps: AdfNode[][],
    writtenGaps: AdfNode[][],
    match: number[],
  ) => {
    // A gap sits before the item of its index; the last one after them all.
    const claimed = new Set<number>();
    const leftSource: AdfNode[] = [];
    const leftWritten: AdfNode[] = [];
    const last = sourceGaps.length - 1;
    const order = [0, ...(last > 0 ? [last] : []), ...sourceGaps.map((_, index) => index).slice(1, last)];
    for (const index of order) {
      const gap = sourceGaps[index]!;
      if (gap.length === 0) continue;
      // At the start or the end, the start or the end; else next to the kept
      // block before it, from that side; else next to the kept block after it.
      let target = -1;
      let fromEnd = false;
      if (index === 0) {
        target = 0;
      } else if (index === last) {
        target = writtenGaps.length - 1;
        fromEnd = true;
      } else if (match[index - 1]! >= 0 && writtenGaps[match[index - 1]! + 1]!.length > 0) {
        target = match[index - 1]! + 1;
      } else if (match[index]! >= 0 && writtenGaps[match[index]!]!.length > 0) {
        target = match[index]!;
        fromEnd = true;
      }
      if (target === -1 || claimed.has(target)) {
        leftSource.push(...gap);
        continue;
      }
      claimed.add(target);
      const writtenGap = fromEnd ? [...writtenGaps[target]!].reverse() : writtenGaps[target]!;
      const sourceGap = fromEnd ? [...gap].reverse() : gap;
      sourceGap.forEach((node, at) => (at < writtenGap.length ? keep(node, writtenGap[at]!) : leftSource.push(node)));
      leftWritten.push(...writtenGap.slice(sourceGap.length));
    }
    leftWritten.push(...writtenGaps.flatMap((gap, index) => (claimed.has(index) ? [] : gap)));
    if (leftSource.length === leftWritten.length) {
      leftSource.forEach((node, at) => keep(node, leftWritten[at]!));
    } else {
      leftSource.forEach(leftOver);
      leftWritten.forEach((node) => resolvedWritten.add(node));
    }
  };

  /** Lines up the children of a pair of blocks. */
  const pairBlocks = (sourceKids: AdfNode[], writtenKids: AdfNode[]) => {
    const split = (kids: AdfNode[]) => {
      const items: AdfNode[] = [];
      const gaps: AdfNode[][] = [[]];
      for (const kid of kids) {
        if (markdownOf(kid) === "") gaps[gaps.length - 1]!.push(kid);
        else {
          items.push(kid);
          gaps.push([]);
        }
      }
      return { items, gaps };
    };
    const sourceSide = split(sourceKids);
    const writtenSide = split(writtenKids);
    const key = (node: AdfNode) => `${String(node.type)}\u0000${markdownOf(node)}`;
    const match = lineUp(sourceSide.items, writtenSide.items, key);
    // For the empty blocks' boundaries, a block moved whole counts as kept where it now stands.
    const where = [...match];
    const taken = new Set(match.filter((at) => at >= 0));
    sourceSide.items.forEach((node, index) => {
      if (where[index]! >= 0) return;
      const json = JSON.stringify(node);
      const at = writtenSide.items.findIndex((other, otherAt) => !taken.has(otherAt) && JSON.stringify(other) === json);
      if (at >= 0) {
        where[index] = at;
        taken.add(at);
      }
    });
    pairEmpty(sourceSide.gaps, writtenSide.gaps, where);

    let sourceAt = 0;
    let writtenAt = 0;
    const pairRun = (sourceEnd: number, writtenEnd: number) => {
      const sourceRun = sourceSide.items.slice(sourceAt, sourceEnd);
      const writtenRun = writtenSide.items.slice(writtenAt, writtenEnd);
      if (sourceRun.length === writtenRun.length && sourceRun.every((node, at) => node.type === writtenRun[at]!.type)) {
        sourceRun.forEach((node, at) => pairChanged(node, writtenRun[at]!));
        return;
      }
      for (const node of sourceRun) {
        const sameSource = sourceRun.filter((other) => other.type === node.type);
        const sameWritten = writtenRun.filter((other) => other.type === node.type);
        if (sameSource.length === 1 && sameWritten.length === 1) pairChanged(node, sameWritten[0]!);
      }
    };
    sourceSide.items.forEach((node, index) => {
      const at = match[index]!;
      if (at === -1) return;
      pairRun(index, at);
      keep(node, writtenSide.items[at]!);
      sourceAt = index + 1;
      writtenAt = at + 1;
    });
    pairRun(sourceSide.items.length, writtenSide.items.length);
  };

  /** Lines up the lines, hard breaks and atoms of a pair of runs of text. */
  const pairInline = (sourceKids: AdfNode[], writtenKids: AdfNode[]) => {
    const split = (kids: AdfNode[]) => {
      const lines: AdfNode[][] = [[]];
      const breaks: AdfNode[] = [];
      for (const kid of kids) {
        if (kid.type === "hardBreak") {
          breaks.push(kid);
          lines.push([]);
        } else {
          lines[lines.length - 1]!.push(kid);
        }
      }
      return { lines, breaks };
    };
    const sourceSide = split(sourceKids);
    const writtenSide = split(writtenKids);
    const match = lineUpLines(sourceSide.lines, writtenSide.lines, lineOf);

    // A break is the break after its line, or before the next one, if that
    // line is kept and still has a break on that side.
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
      keep(node, writtenSide.breaks[target]!);
    });
    const leftWritten = writtenSide.breaks.filter((_, index) => !claimed.has(index));
    if (leftSource.length === leftWritten.length) {
      leftSource.forEach((node, at) => keep(node, leftWritten[at]!));
    } else {
      leftSource.forEach(leftOver);
      leftWritten.forEach((node) => resolvedWritten.add(node));
    }

    // Atoms of a kept line are that line's, in order.
    const atoms = (nodes: AdfNode[]) => nodes.filter((node) => node.type !== "text");
    sourceSide.lines.forEach((line, index) => {
      if (match[index]! < 0) return;
      const writtenLine = atoms(writtenSide.lines[match[index]!]!);
      atoms(line).forEach((node, at) => keep(node, writtenLine[at]!));
    });
    // In changed lines, an atom that reads the same as one source atom of the
    // run, and no other, is that atom.
    const changedSource = sourceSide.lines.flatMap((line, index) => (match[index]! < 0 ? atoms(line) : []));
    const keptWritten = new Set(match.filter((at) => at >= 0));
    const changedWritten = writtenSide.lines.flatMap((line, index) => (keptWritten.has(index) ? [] : atoms(line)));
    for (const node of changedSource) {
      const sameSource = changedSource.filter((other) => markdownOf(other) === markdownOf(node) && other.type === node.type);
      const sameWritten = changedWritten.filter((other) => markdownOf(other) === markdownOf(node) && other.type === node.type);
      if (sameSource.length === 1 && sameWritten.length === 1) keep(node, sameWritten[0]!);
    }
  };

  /** Two blocks paired as the same block, changed: their content is checked by context. */
  const pairChanged = (sourceNode: AdfNode, writtenNode: AdfNode) => {
    if (sourceNode.type !== writtenNode.type) return;
    changedPairs.push({ source: sourceNode, written: writtenNode });
    if (INLINE_CONTAINERS.has(String(sourceNode.type))) pairInline(childrenOf(sourceNode), childrenOf(writtenNode));
    else pairBlocks(childrenOf(sourceNode), childrenOf(writtenNode));
  };

  pairBlocks(source.content as AdfNode[], written.content as AdfNode[]);

  // Then conservation, for what context left unresolved.
  const inventory = (content: AdfNode[], resolved: Set<AdfNode>) => {
    const entries: Entry[] = [];
    const walk = (nodes: AdfNode[], depth: number) => {
      for (const node of nodes) {
        if (resolved.has(node)) continue;
        if (node.type !== "text") {
          const markdown = markdownOf(node);
          if (markdown !== "") {
            entries.push({ node, key: `${String(node.type)}\u0000${markdown}`, json: JSON.stringify(node), order: entries.length, depth });
          }
        }
        walk(childrenOf(node), depth + 1);
      }
    };
    walk(content, 0);
    return entries;
  };
  const sourceEntries = inventory(source.content as AdfNode[], resolvedSources);
  const writtenEntries = inventory(written.content as AdfNode[], resolvedWritten);
  // A twin that differs only in ids stays in the pool even when context
  // paired it as changed: the earliest of such twins are the ones kept.
  const changedSources = new Set(changedPairs.map((pair) => pair.source).filter((node) => !isIdTwin(node)));
  const changedWritten = new Set(changedPairs.map((pair) => pair.written));

  // Deep-equal nodes, outermost first: a written node equal to a source node
  // with its key is that node, and everything under both survived with it.
  const sourceByKey = new Map<string, Entry[]>();
  for (const entry of sourceEntries) sourceByKey.set(entry.key, [...(sourceByKey.get(entry.key) ?? []), entry]);
  const matched = new Map<Entry, Entry>();
  const matchedSources = new Set<AdfNode>();
  const covered = new Set<AdfNode>();
  for (const entry of [...writtenEntries].sort((left, right) => left.depth - right.depth || left.order - right.order)) {
    if (covered.has(entry.node) || changedWritten.has(entry.node)) continue;
    const twin = (sourceByKey.get(entry.key) ?? []).find(
      (candidate) =>
        !matched.has(candidate) &&
        !covered.has(candidate.node) &&
        !changedSources.has(candidate.node) &&
        candidate.json === entry.json &&
        everyNode(childrenOf(candidate.node)).every((each) => !matchedSources.has(each)),
    );
    if (!twin) continue;
    matched.set(twin, entry).set(entry, twin);
    matchedSources.add(twin.node);
    for (const node of [twin.node, entry.node]) everyNode(childrenOf(node)).forEach((each) => covered.add(each));
  }

  const byKey = (entries: Entry[], changed: Set<AdfNode>) => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (!covered.has(entry.node) && !changed.has(entry.node)) map.set(entry.key, [...(map.get(entry.key) ?? []), entry]);
    }
    return map;
  };
  const sources = byKey(sourceEntries, changedSources);
  const writtens = byKey(writtenEntries, changedWritten);

  const freeSources: AdfNode[] = changedPairs.map((pair) => pair.source);
  const freeWritten: AdfNode[] = changedPairs.map((pair) => pair.written);
  for (const [key, sourceNodes] of sources) {
    const writtenNodes = writtens.get(key) ?? [];
    // The key is gone: the user changed or deleted these.
    if (writtenNodes.length === 0) {
      freeSources.push(...sourceNodes.map((entry) => entry.node));
      continue;
    }
    const idTwins = sourceNodes.length > 1 && new Set(sourceNodes.map((entry) => withoutIdentity(entry.node))).size === 1;
    // Among twins that differ only in ids, one not written itself but with
    // nodes under it written elsewhere was changed by the user, as a list
    // item whose paragraph went into the item the user edited.
    const changed = (entry: Entry) =>
      idTwins &&
      !matched.has(entry) &&
      everyNode(childrenOf(entry.node)).some((each) => matchedSources.has(each) || placedSources.has(each));
    freeSources.push(...sourceNodes.filter(changed).map((entry) => entry.node));
    const eligible = sourceNodes.filter((entry) => !changed(entry));
    if (writtenNodes.length < eligible.length) {
      // Fewer left: only twins that differ in nothing but ids, the earliest kept.
      if (!idTwins) throw new Error(AMBIGUOUS_EDIT);
      const kept = eligible.slice(0, writtenNodes.length);
      const later = eligible.slice(writtenNodes.length);
      rebuilt.push(...kept.filter((entry) => !matched.has(entry)).map((entry) => entry.node));
      freeSources.push(...later.filter((entry) => !matched.has(entry)).map((entry) => entry.node));
      // A later twin kept in place of an earlier one is not the rule.
      invalid.push(...later.filter((entry) => matched.has(entry)).map((entry) => matched.get(entry)!.node));
    } else {
      // Every source node with the key must be written as it was.
      rebuilt.push(...eligible.filter((entry) => !matched.has(entry)).map((entry) => entry.node));
    }
  }
  for (const writtenNodes of writtens.values()) {
    // Written nodes no source node accounts for: the user's change or copy.
    freeWritten.push(...writtenNodes.filter((entry) => !matched.has(entry)).map((entry) => entry.node));
  }

  // A changed node's ids come from a source node of its kind that did not
  // survive as itself, so no id is taken from a surviving node; the other
  // attributes the writer never gives come from a source node of its kind.
  const allSources = everyNode(source.content as AdfNode[]);
  const sourceIds = new Set(allSources.flatMap(identitiesOf));
  for (const node of new Set(freeWritten)) {
    const attrs = node.attrs ?? {};
    const carried = (CARRIED_ATTRIBUTES[String(node.type)] ?? []).filter((name) => name in attrs);
    const ids = identitiesOf(node).filter((id) => sourceIds.has(id));
    const idDonor =
      ids.length === 0 ||
      freeSources.some((candidate) => candidate.type === node.type && ids.every((id) => identitiesOf(candidate).includes(id)));
    const attributeDonor =
      carried.length === 0 ||
      allSources.some((candidate) => candidate.type === node.type && carried.every((name) => candidate.attrs?.[name] === attrs[name]));
    if (!idDonor || !attributeDonor) invalid.push(node);
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
