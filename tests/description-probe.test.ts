import { describe, expect, it } from "vitest";
import { adfToMarkdown, adfToMarkdownParts } from "../src/adf-markdown.ts";
import { checkPreservation } from "../src/description-guard.ts";
import { patchDescriptionAdf } from "../src/description-patch.ts";
import { describeJiraDescription, NOT_WRITABLE_EXACTLY } from "../src/description.ts";
import { markdownToAdf } from "../src/markdown-adf.ts";

// Generated documents from what the reader keeps, with spaces and characters
// Markdown reads as syntax: whenever the reader names no loss, the write must
// give back the same ADF. A loss the reader names is fine; a silent change is not.

type Node = Record<string, unknown> & { type?: string; attrs?: Record<string, unknown>; marks?: Node[]; content?: Node[] };

/** A small seeded generator, so a failure repeats. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const context = { issueUrl: "https://acme.atlassian.net/browse/ABC-1" };

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const merged: Node[] = [];
    for (const node of value.map(normalize) as Node[]) {
      const previous = merged[merged.length - 1];
      if (previous?.type === "text" && node.type === "text" && JSON.stringify(previous.marks) === JSON.stringify(node.marks)) {
        merged[merged.length - 1] = { ...previous, text: String(previous.text) + String(node.text) };
      } else {
        merged.push(node);
      }
    }
    return merged;
  }
  if (typeof value !== "object" || value === null) return value;
  const node = { ...(value as Node) };
  const attrs = { ...(node.attrs ?? {}) };
  delete attrs.localId;
  if (node.type === "orderedList" && attrs.order === 1) delete attrs.order;
  if (node.type === "table") {
    delete attrs.isNumberColumnEnabled;
    delete attrs.layout;
  }
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  else delete node.attrs;
  if (Array.isArray(node.marks)) {
    const marks = (node.marks as Node[]).map((mark) => normalize(mark) as Node);
    marks.sort((left, right) => String(left.type).localeCompare(String(right.type)));
    if (marks.length > 0) node.marks = marks;
    else delete node.marks;
  }
  if (Array.isArray(node.content)) {
    const content = normalize(node.content) as Node[];
    if (content.length > 0) node.content = content;
    else delete node.content;
  }
  return node;
}

const WORDS = ["a", "b c", " ", "  ", "x_y", "*", "**", "_", "~", "~~", "`", "[", "]", "(", ")", "!", "#", "# ", "1.", "1) ", "- ", "+", ">", "<", "&amp;", "&", "|", "\\", ":", " ", "\t", "http://e.com", "@", "=", "---", "😀"];

function generate(next: () => number) {
  const pick = <T,>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const inline = (allowBreaks: boolean): Node[] => {
    const nodes: Node[] = [];
    const count = 1 + Math.floor(next() * 5);
    for (let index = 0; index < count; index += 1) {
      const roll = next();
      if (roll < 0.06 && allowBreaks) nodes.push({ type: "hardBreak" });
      else if (roll < 0.1) nodes.push({ type: "mention", attrs: { id: "557058:x", text: `@${pick(["Ana", "B [c]", "D*"])}` } });
      else if (roll < 0.13) nodes.push({ type: "inlineCard", attrs: { url: pick(["https://e.com/a", "https://e.com/a_(b)"]) } });
      else {
        const marks: Node[] = [];
        if (next() < 0.15) marks.push({ type: "code" });
        else {
          if (next() < 0.3) marks.push({ type: "strong" });
          if (next() < 0.3) marks.push({ type: "em" });
          if (next() < 0.15) marks.push({ type: "strike" });
        }
        if (next() < 0.15) marks.push({ type: "link", attrs: { href: pick(["https://e.com", "https://e.com/a b", "mailto:a@b.c"]) } });
        const words = Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(WORDS)).join("");
        nodes.push({ type: "text", text: words, ...(marks.length > 0 ? { marks } : {}) });
      }
    }
    return nodes;
  };
  const paragraph = (): Node => ({ type: "paragraph", content: inline(true) });
  const block = (depth: number): Node => {
    const roll = next();
    if (roll < 0.45 || depth > 1) return paragraph();
    if (roll < 0.55) return { type: "heading", attrs: { level: 1 + Math.floor(next() * 6) }, content: inline(false) };
    if (roll < 0.65) {
      const ordered = next() < 0.5;
      return {
        type: ordered ? "orderedList" : "bulletList",
        ...(ordered ? { attrs: { order: pick([1, 2, 10]) } } : {}),
        content: Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
          type: "listItem",
          content: [paragraph(), ...(next() < 0.3 ? [block(depth + 1)] : [])].filter(
            (child) => ["paragraph", "bulletList", "orderedList", "codeBlock"].includes(String(child.type)),
          ),
        })),
      };
    }
    if (roll < 0.72) return { type: "codeBlock", ...(next() < 0.5 ? { attrs: { language: "js" } } : {}), content: [{ type: "text", text: pick(["x", "a\n\nb", "```", "  y\t", "~~~\n"]) }] };
    if (roll < 0.8) return { type: "blockquote", content: [paragraph(), ...(next() < 0.5 ? [paragraph()] : [])] };
    if (roll < 0.86) return { type: "rule" };
    if (roll < 0.93) {
      const row = (type: string) => ({ type: "tableRow", content: [0, 1].map(() => ({ type, content: [{ type: "paragraph", content: inline(false) }] })) });
      return { type: "table", content: [row("tableHeader"), row("tableCell")] };
    }
    if (roll < 0.96) {
      const media = (id: string) => ({
        type: "media",
        attrs: { type: "file", id, collection: "", ...(next() < 0.5 ? { alt: pick(["a.png", "b [1].png"]) } : {}), ...(next() < 0.5 ? { width: 4, height: 3 } : {}) },
      });
      return next() < 0.6
        ? { type: "mediaSingle", attrs: { layout: pick(["center", "wide", "align-start"]), ...(next() < 0.5 ? { width: 50 } : {}) }, content: [media("f1")] }
        : { type: "mediaGroup", content: [media("f2"), media("f3")] };
    }
    const item = () => ({ type: "taskItem", attrs: { localId: "t", state: pick(["TODO", "DONE"]) }, content: inline(false) });
    return {
      type: "taskList",
      attrs: { localId: "l" },
      content: [item(), ...(next() < 0.4 ? [{ type: "taskList", attrs: { localId: "m" }, content: [item()] }, item()] : [])],
    };
  };
  return { type: "doc", version: 1, content: Array.from({ length: 1 + Math.floor(next() * 4) }, () => block(0)) };
}

/** A node as JSON without its ids. */
function withoutIds(node: unknown) {
  return JSON.stringify(node, (key, value) => (key === "localId" || key === "uniqueId" ? undefined : value));
}

/**
 * For the top-level lists the write kept as lists, whether the items that
 * have twins differing only in ids are written as the earliest source twins,
 * in order. Undefined when no list has fewer such twins written than read.
 */
function earliestTwins(source: { content: unknown[] }, written: { content: unknown[] }) {
  const lists = (document: { content: unknown[] }) =>
    (document.content as Node[]).filter((node) => ["bulletList", "orderedList", "taskList"].includes(String(node.type)));
  const sourceLists = lists(source);
  const writtenLists = lists(written);
  if (sourceLists.length !== writtenLists.length) return undefined;
  let checked = false;
  for (const [index, list] of sourceLists.entries()) {
    const items = (list.content ?? []) as Node[];
    const writtenItems = (writtenLists[index]!.content ?? []) as Node[];
    for (const item of items) {
      const twins = items.filter((other) => withoutIds(other) === withoutIds(item));
      if (twins.length < 2 || new Set(twins.map((twin) => JSON.stringify(twin))).size < 2) continue;
      const kept = writtenItems.filter((other) => withoutIds(other) === withoutIds(item));
      if (kept.length === 0 || kept.length >= twins.length) continue;
      checked = true;
      const expected = twins.slice(0, kept.length).map((twin) => JSON.stringify(twin));
      if (JSON.stringify(kept.map((twin) => JSON.stringify(twin))) !== JSON.stringify(expected)) {
        return { ok: false, expected, kept: kept.map((twin) => JSON.stringify(twin)) };
      }
    }
  }
  return checked ? { ok: true } : undefined;
}

/** Every id a document holds, at every depth. */
function everyId(value: { content?: unknown }) {
  const ids: string[] = [];
  const walk = (node: Node) => {
    if (typeof node.attrs?.localId === "string") ids.push(node.attrs.localId);
    (Array.isArray(node.content) ? (node.content as Node[]) : []).forEach(walk);
  };
  walk(value as Node);
  return ids;
}

/** Gives every node an id, and mentions, cells and tables neutral attributes. */
function decorate<T>(value: T, next: () => number = () => 0): T {
  let count = 0;
  const walk = (node: Node): Node => {
    const copy: Node = { ...node };
    // Some lists hold an item twice: identical, or with an id of its own.
    if (Array.isArray(node.content) && ["bulletList", "orderedList", "taskList"].includes(String(node.type)) && next() < 0.3) {
      const at = Math.floor(next() * node.content.length);
      copy.content = [...node.content.slice(0, at + 1), node.content[at], ...node.content.slice(at + 1)];
    }
    if (node.type !== "text" && node.type !== "doc") {
      const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
      // Most nodes have an id; those without make identical twins.
      if (node.type === "taskList" || node.type === "taskItem" || next() < 0.8) attrs.localId = `n${(count += 1)}`;
      if (node.type === "mention") {
        // The same person mentioned with different attributes.
        Object.assign(attrs, { accessLevel: ["", "CONTAINER"][Math.floor(next() * 2)], userType: ["DEFAULT", "APP"][Math.floor(next() * 2)] });
      }
      if (node.type === "tableHeader" || node.type === "tableCell") Object.assign(attrs, { colspan: 1, rowspan: 1 });
      if (node.type === "table") Object.assign(attrs, { isNumberColumnEnabled: false, layout: "center", width: 760 });
      if (node.type === "hardBreak") Object.assign(attrs, { text: "\n" });
      // Code blocks carry Jira's other id.
      if (node.type === "codeBlock" && next() < 0.8) attrs.uniqueId = `u${(count += 1)}`;
      if (Object.keys(attrs).length > 0 || node.attrs) copy.attrs = attrs;
    }
    if (Array.isArray(copy.content)) copy.content = copy.content.map(walk);
    return copy;
  };
  return walk(value as Node) as T;
}

/** The top-level item lines of a list, by index. */
function itemLines(lines: string[]) {
  return lines.map((line, index) => ({ line, index })).filter(({ line }) => /^(?:- |\d+\. )/.test(line));
}

/** Swaps two neighbouring single-line items of a list. */
function swapItems(markdown: string, pick: number) {
  const lines = markdown.split("\n");
  const items = itemLines(lines).filter(({ index }) => /^(?:- |\d+\. )/.test(lines[index + 1] ?? ""));
  if (items.length === 0) return markdown;
  const { index } = items[Math.floor(pick * items.length)]!;
  const marker = (line: string) => /^(?:- \[[ x]\] |- |\d+\. )/.exec(line)![0];
  const [first, second] = [lines[index]!, lines[index + 1]!];
  // Ordered lists keep their numbers; the items move.
  lines[index] = marker(first) + second.slice(marker(second).length);
  lines[index + 1] = marker(second) + first.slice(marker(first).length);
  return lines.join("\n");
}

/** Deletes or duplicates one single-line item of a list. */
function dropOrCopyItem(markdown: string, pick: number, copy: boolean) {
  const lines = markdown.split("\n");
  const items = itemLines(lines).filter(({ index }) => !/^\s/.test(lines[index + 1] ?? ""));
  if (items.length < 2) return markdown;
  const { index } = items[Math.floor(pick * items.length)]!;
  if (copy) lines.splice(index, 0, lines[index]!);
  else lines.splice(index, 1);
  return lines.join("\n");
}

/** Deletes, or edits, one of two items of a list that read the same. */
function touchTwin(markdown: string, pick: number) {
  const lines = markdown.split("\n");
  const twins = itemLines(lines).filter(
    ({ line, index }) => !/^\s/.test(lines[index + 1] ?? "") && lines.some((other, at) => at !== index && other === line),
  );
  if (twins.length === 0) return markdown;
  const { index } = twins[Math.floor(pick * twins.length)]!;
  if (pick < 0.5) lines.splice(index, 1);
  else lines[index] = `${lines[index]} zz`;
  return lines.join("\n");
}

/** Whether a block's Markdown is plain lines: no fence, table or list. */
function isPlainLines(markdown: string) {
  return !/^(?:\s*(?:```|~~~|\||- |\d+\. |> )|#)/m.test(markdown);
}

/** Changes the kind of a block around unchanged text: heading, list item or quote. */
function changeKind(markdown: string, pick: number) {
  if (/^#{1,6} /.test(markdown)) return markdown.replace(/^#{1,6} /, "");
  if (!isPlainLines(markdown)) return markdown.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
  const lines = markdown.split("\n");
  if (pick < 0.33) return `## ${lines.join(" ")}`;
  if (pick < 0.66) return lines.map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`)).join("\n");
  return lines.map((line) => `> ${line}`).join("\n");
}

/** Adds or deletes a line inside a block of plain lines, so its hard breaks change. */
function changeLines(markdown: string, pick: number) {
  if (!isPlainLines(markdown)) return markdown;
  const lines = markdown.split("\n");
  const at = Math.floor(pick * lines.length);
  if (pick < 0.5 || lines.length < 2) lines.splice(at + 1, 0, "added line");
  else lines.splice(at, 1);
  return lines.join("\n");
}

/** Deletes the first mention on a line that has one. */
function dropMention(markdown: string) {
  return markdown.replace(/\[@[^\]]*\]\(mention:[^)]*\)/, "");
}

/** Changes one line inside a block: a table row's last cell, or the line's end. */
function editLine(markdown: string, pick: number) {
  const lines = markdown.split("\n");
  const at = Math.floor(pick * lines.length);
  const line = lines[at]!;
  if (/^\s*(?:```|~~~|\| ---)/.test(line) || line.trim() === "") return markdown;
  lines[at] = line.startsWith("|") ? line.replace(/ \|$/, " zz |") : `${line} zz`;
  return lines.join("\n");
}

describe("generated descriptions", () => {
  it("never change silently: a description that names no loss writes back as the same ADF", () => {
    const failures: unknown[] = [];
    let unchanged = 0;
    for (let seed = 1; seed <= 5000 && failures.length < 4; seed += 1) {
      const value = generate(random(seed));
      const described = describeJiraDescription(value, context);
      // The guard: Markdown that would not write back as itself is named.
      const markdown = adfToMarkdown(markdownToAdf(described.text), context) ?? "";
      if (!described.lost?.includes(NOT_WRITABLE_EXACTLY) && markdown !== described.text) {
        failures.push({ seed, kind: "markdown", text: described.text, markdown });
      }
      if (described.lost) continue;
      unchanged += 1;
      // Top-level empty lines have no Markdown; the write keeps them in place
      // around the blocks it keeps, which the writeDescription tests cover.
      const withoutGaps = { ...value, content: value.content.filter((node) => (adfToMarkdown({ type: "doc", content: [node] }) ?? "") !== "") };
      if (JSON.stringify(normalize(markdownToAdf(described.text))) !== JSON.stringify(normalize(withoutGaps))) {
        failures.push({ seed, kind: "adf", text: described.text, value: JSON.stringify(value) });
      }
    }
    expect(failures).toEqual([]);
    // Enough of them name no loss for the check to mean something.
    expect(unchanged).toBeGreaterThan(300);
  }, 60_000);

  it("keep every block and empty line an edit leaves alone, and read back as the edit", () => {
    const failures: unknown[] = [];
    for (let seed = 1; seed <= 2000 && failures.length < 4; seed += 1) {
      const next = random(seed);
      const value = generate(next);
      // Empty lines between blocks, as Jira's editor leaves them.
      const content = value.content.flatMap((node) => (next() < 0.3 ? [{ type: "paragraph" }, node] : [node]));
      const source = { ...value, content: [...content, ...(next() < 0.3 ? [{ type: "paragraph" }] : [])] };
      const read = adfToMarkdownParts(source, context);
      if (!read || read.parts.length < 2) continue;
      const edited = Math.floor(next() * read.parts.length);
      const markdown = read.parts.map((part, index) => (index === edited ? "Edited **text**" : part.markdown)).join("\n\n");

      const written = patchDescriptionAdf(source, markdown, context);
      // The edit reads back as itself, every block it left alone reading as it did.
      if ((adfToMarkdown(written, context) ?? "") !== markdown) {
        failures.push({ seed, kind: "reads", markdown, written: adfToMarkdown(written, context) });
        continue;
      }
      // Each block the edit left alone is still there, as it was, in order.
      const kept = read.parts.filter((_, index) => index !== edited).map((part) => source.content[part.index]);
      const found = kept.filter((node) => written.content.some((each) => JSON.stringify(each) === JSON.stringify(node)));
      // A new paragraph set apart by blank lines joins no block.
      if (found.length !== kept.length) failures.push({ seed, kind: "kept", parts: read.parts.map((part) => part.markdown), edited, written: written.content.map((node) => JSON.stringify(node).slice(0, 120)), kept: kept.length, found: found.length });
      // Every empty line stays, as the blank lines around the edit did.
      const gaps = (nodes: unknown[]) => nodes.filter((node) => (node as { type?: string; content?: unknown }).type === "paragraph" && !(node as { content?: unknown }).content).length;
      if (gaps(written.content) !== gaps(source.content)) failures.push({ seed, kind: "gaps", markdown });
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("read back as the edit, whatever the edit, when the description writes back as itself", () => {
    const failures: unknown[] = [];
    const edits = [
      (parts: string[], at: number) => parts.filter((_, index) => index !== at),
      (parts: string[], at: number) => [...parts.slice(0, at), "New *line*", ...parts.slice(at)],
      (parts: string[], at: number) => parts.map((part, index) => (index === at ? `${part}\nmore` : part)),
      (parts: string[], at: number) => parts.map((part, index) => (index === at ? `${part}\n\n- added` : part)),
      (parts: string[], at: number) => parts.map((part, index) => (index === at ? `- added\n\n${part}` : part)),
      (parts: string[], at: number) => parts.map((part, index) => (index === at ? `${part}\n  indented` : part)),
      // Moves and duplicates.
      (parts: string[], at: number) => [parts[at]!, ...parts.filter((_, index) => index !== at)],
      (parts: string[], at: number) => [...parts.filter((_, index) => index !== at), parts[at]!],
      (parts: string[], at: number) => [...parts, parts[at]!],
      // Edits inside a block: a table cell, a list or task item, a quote's line.
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? editLine(part, pick) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? editLine(part, pick) : part)),
      // Reorders, deletions and copies among a list's items, twins included,
      // and a deleted mention beside others of the same person.
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? swapItems(part, pick) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? swapItems(part, pick) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? dropOrCopyItem(part, pick, false) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? dropOrCopyItem(part, pick, true) : part)),
      (parts: string[], at: number) => parts.map((part, index) => (index === at ? dropMention(part) : part)),
      // One of two twins deleted or edited, in any list.
      (parts: string[], _at: number, pick: number) => parts.map((part) => touchTwin(part, pick)),
      (parts: string[], _at: number, pick: number) => parts.map((part) => touchTwin(part, pick)),
      // A block's kind changed around unchanged text, and lines added or
      // deleted between hard breaks.
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? changeKind(part, pick) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? changeKind(part, pick) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? changeLines(part, pick) : part)),
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? changeLines(part, pick) : part)),
    ];
    let refused = 0;
    let twinCases = 0;
    let checked = 0;
    for (let seed = 1; seed <= 4000 && failures.length < 4; seed += 1) {
      const next = random(seed);
      // Most nodes have their own id, and mentions, cells and tables the
      // attributes Markdown has no place for, so keeping a node means keeping
      // that very node.
      // Some descriptions hold a block twice, as code-block twins.
      const generated = generate(next);
      if (next() < 0.3) {
        const at = Math.floor(next() * generated.content.length);
        generated.content.splice(at + 1, 0, generated.content[at]!);
      }
      const value = decorate(generated, next);
      const source = { ...value, content: value.content.flatMap((node) => (next() < 0.3 ? [{ type: "paragraph" }, node] : [node])) };
      if (describeJiraDescription(source, context).lost?.includes(NOT_WRITABLE_EXACTLY)) continue;
      const read = adfToMarkdownParts(source, context)!;
      const at = Math.floor(next() * read.parts.length);
      const edit = edits[Math.floor(next() * edits.length)]!;
      const markdown = edit(read.parts.map((part) => part.markdown), at, next()).join("\n\n");
      let written;
      try {
        written = patchDescriptionAdf(source, markdown, context);
      } catch (error) {
        // An ambiguous edit is refused, never guessed.
        expect(String(error)).toMatch(/cannot tell which you kept|too large/);
        refused += 1;
        continue;
      }
      checked += 1;
      const expected = adfToMarkdown(markdownToAdf(markdown), context) ?? "";
      if ((adfToMarkdown(written, context) ?? "") !== expected) {
        failures.push({ seed, kind: "reads", markdown, expected, written: adfToMarkdown(written, context) });
      }
      // The independent guard, at every depth: every node whose Markdown the
      // edit kept is in the write as its very source ADF, ids and attributes
      // included; changed nodes carry only what a gone source node had; no
      // written node shares an id with another.
      let report;
      try {
        report = checkPreservation(source, written, context);
      } catch (error) {
        failures.push({ seed, kind: "guard refused what the patch wrote", markdown, error: String(error) });
        continue;
      }
      if (report.rebuilt.length > 0 || report.invalid.length > 0) {
        failures.push({ seed, kind: "guard", markdown, rebuilt: JSON.stringify(report.rebuilt), invalid: JSON.stringify(report.invalid) });
      }
      const ids = everyId(written);
      if (new Set(ids).size !== ids.length) failures.push({ seed, kind: "shared id", markdown, ids });
      // Twins that differ only in ids, among a list's items: the written ones
      // are the earliest source twins, in order.
      const twinOrder = earliestTwins(source, written);
      if (twinOrder) {
        twinCases += 1;
        if (!twinOrder.ok) failures.push({ seed, kind: "twin order", markdown, ...twinOrder });
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(1000);
    expect(refused).toBeLessThan(checked / 5);
    // Deleting or editing among twins that differ only in ids happens often enough to mean something.
    expect(twinCases).toBeGreaterThan(10);
  }, 60_000);

  it("the independent guard names a kept node written otherwise, and ids a changed node could not have", () => {
    const keep = { type: "paragraph", attrs: { localId: "k" }, content: [{ type: "text", text: "Keep" }] };
    const old = { type: "paragraph", attrs: { localId: "o" }, content: [{ type: "text", text: "Old" }] };
    const source = { type: "doc", version: 1, content: [keep, old] };
    const changed = (localId: string) => ({ type: "paragraph", attrs: { localId }, content: [{ type: "text", text: "New" }] });

    expect(checkPreservation(source, markdownToAdf("Keep\n\nNew"), context)).toEqual({ rebuilt: [keep], invalid: [] });
    expect(checkPreservation(source, { content: [keep, changed("o")] }, context)).toEqual({ rebuilt: [], invalid: [] });
    // An id taken from a node that survived.
    const stolen = changed("k");
    expect(checkPreservation(source, { content: [keep, stolen] }, context).invalid).toContain(stolen);
    expect(checkPreservation(source, patchDescriptionAdf(source, "Keep\n\nNew", context), context)).toEqual({ rebuilt: [], invalid: [] });
  });

  it("the conservation check catches a mention rebuilt when its paragraph became a heading", () => {
    // As the patch wrote it before round 4: the mention lost its attributes.
    const ana = { type: "mention", attrs: { id: "x", text: "@Ana", accessLevel: "CONTAINER", userType: "DEFAULT" } };
    const source = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Ask " }, ana] }] };
    const written = {
      content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Ask " }, { type: "mention", attrs: { id: "x", text: "@Ana" } }] }],
    };

    expect(checkPreservation(source, written, context).rebuilt).toEqual([ana]);
    expect(checkPreservation(source, patchDescriptionAdf(source, "# Ask [@Ana](mention:x)", context), context)).toEqual({ rebuilt: [], invalid: [] });
  });

  it("the conservation check catches a hard break rebuilt when a line was added", () => {
    // As the patch wrote it before round 4: the existing break lost its id and text.
    const lineBreak = { type: "hardBreak", attrs: { text: "\n", localId: "break-1" } };
    const t = (value: string) => ({ type: "text", text: value });
    const source = { type: "doc", version: 1, content: [{ type: "paragraph", content: [t("a"), lineBreak, t("b")] }] };
    const written = { content: [{ type: "paragraph", content: [t("a"), { type: "hardBreak" }, t("b"), { type: "hardBreak" }, t("c")] }] };

    expect(checkPreservation(source, written, context).rebuilt).toEqual([lineBreak]);
    expect(checkPreservation(source, patchDescriptionAdf(source, "a\nb\nc", context), context)).toEqual({ rebuilt: [], invalid: [] });
  });

  it("the conservation check names a uniqueId written twice", () => {
    const code = (uniqueId: string, value: string) => ({ type: "codeBlock", attrs: { uniqueId }, content: [{ type: "text", text: value }] });
    const source = { type: "doc", version: 1, content: [code("A", "x"), code("B", "x")] };
    const edited = code("A", "y");

    expect(checkPreservation(source, { content: [edited, code("A", "x")] }, context).invalid).toContain(edited);
  });

  it("the independent guard accepts deleting one of twins that differ only in ids, as distinct source nodes", () => {
    const note = (localId: string) => ({ type: "paragraph", attrs: { localId }, content: [{ type: "text", text: "Note" }] });
    const [first, second] = [note("a"), note("b")];
    const source = { type: "doc", version: 1, content: [first, second] };

    expect(checkPreservation(source, { content: [first] }, context)).toEqual({ rebuilt: [], invalid: [] });
    // The earliest twin is the one kept.
    expect(checkPreservation(source, { content: [second] }, context)).toEqual({ rebuilt: [first], invalid: [second] });
    // The same twin twice, or one without its id, is not a source node.
    expect(checkPreservation(source, { content: [first, first] }, context).invalid).toContain(first);
    expect(checkPreservation(source, { content: [note("z")] }, context).rebuilt).toEqual([first]);
  });

  it("the independent guard refuses when which of differing twins survived is open", () => {
    const twin = (accessLevel: string) => ({ type: "mention", attrs: { id: "a", text: "@A", accessLevel } });
    const first = twin("");
    const second = twin("CONTAINER");
    const source = { type: "doc", version: 1, content: [{ type: "paragraph", content: [first, { type: "text", text: " " }, second] }] };

    expect(() => checkPreservation(source, { content: [{ type: "paragraph", content: [second] }] }, context)).toThrow(
      "cannot tell which you kept",
    );
  });
});
