import { describe, expect, it } from "vitest";
import { adfToMarkdown, adfToMarkdownParts } from "../src/adf-markdown.ts";
import { patchDescriptionAdf, rebuiltBlocks } from "../src/description-patch.ts";
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

/** Gives every node an id, and mentions, cells and tables neutral attributes. */
function decorate<T>(value: T): T {
  let count = 0;
  const walk = (node: Node): Node => {
    const copy: Node = { ...node };
    if (node.type !== "text" && node.type !== "doc") {
      const attrs: Record<string, unknown> = { ...(node.attrs ?? {}), localId: `n${(count += 1)}` };
      if (node.type === "mention") Object.assign(attrs, { accessLevel: "CONTAINER", userType: "DEFAULT" });
      if (node.type === "tableHeader" || node.type === "tableCell") Object.assign(attrs, { colspan: 1, rowspan: 1 });
      if (node.type === "table") Object.assign(attrs, { isNumberColumnEnabled: false, layout: "center", width: 760 });
      if (node.type === "hardBreak") Object.assign(attrs, { text: "\n" });
      copy.attrs = attrs;
    }
    if (Array.isArray(node.content)) copy.content = node.content.map(walk);
    return copy;
  };
  return walk(value as Node) as T;
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
  });

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
      const found = kept.filter((node) => written.content.includes(node as never));
      // A new paragraph set apart by blank lines joins no block.
      if (found.length !== kept.length) failures.push({ seed, kind: "kept", parts: read.parts.map((part) => part.markdown), edited, written: written.content.map((node) => JSON.stringify(node).slice(0, 120)), kept: kept.length, found: found.length });
      // Every empty line stays, as the blank lines around the edit did.
      const gaps = (nodes: unknown[]) => nodes.filter((node) => (node as { type?: string; content?: unknown }).type === "paragraph" && !(node as { content?: unknown }).content).length;
      if (gaps(written.content) !== gaps(source.content)) failures.push({ seed, kind: "gaps", markdown });
    }
    expect(failures).toEqual([]);
  });

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
      (parts: string[], at: number, pick: number) => parts.map((part, index) => (index === at ? editLine(part, pick) : part)),
    ];
    let refused = 0;
    let checked = 0;
    for (let seed = 1; seed <= 3000 && failures.length < 4; seed += 1) {
      const next = random(seed);
      // Every node has its own id, and mentions, cells and tables the
      // attributes Markdown has no place for, so keeping a node means keeping
      // that very node.
      const value = decorate(generate(next));
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
      // The source-level guard, at every depth: every node whose Markdown the
      // edit kept is in the write as its very source ADF, ids and attributes
      // included, and a changed node keeps its ids.
      const rebuilt = rebuiltBlocks(source, written, markdown, context);
      if (rebuilt.length > 0) failures.push({ seed, kind: "rebuilt", markdown, rebuilt: JSON.stringify(rebuilt) });
    }
    expect(failures).toEqual([]);
    expect(refused).toBeLessThan(checked / 10);
  });

  it("names the source blocks a write rebuilt though their Markdown stayed", () => {
    const keep = { type: "paragraph", attrs: { localId: "k" }, content: [{ type: "text", text: "Keep" }] };
    const source = { type: "doc", version: 1, content: [keep, { type: "paragraph", content: [{ type: "text", text: "Old" }] }] };
    const rebuilt = markdownToAdf("Keep\n\nNew");

    expect(rebuiltBlocks(source, rebuilt, "Keep\n\nNew", context)).toEqual([keep]);
    expect(rebuiltBlocks(source, patchDescriptionAdf(source, "Keep\n\nNew", context), "Keep\n\nNew", context)).toEqual([]);
  });
});
