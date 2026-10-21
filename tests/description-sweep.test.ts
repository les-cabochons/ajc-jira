import { describe, expect, it } from "vitest";
import { adfToMarkdown, adfToMarkdownWithLosses } from "../src/adf-markdown.ts";
import { describeJiraDescription, NOT_WRITABLE_EXACTLY } from "../src/description.ts";
import { markdownToAdf } from "../src/markdown-adf.ts";

// The rule: what the reader keeps, the writer gives back as the same ADF, and
// anything else is named in `lost`. Each case below is either kept, compared
// as ADF after the write, or names exactly what it loses.

type Node = Record<string, unknown> & { type?: string; attrs?: Record<string, unknown>; marks?: Node[]; content?: Node[] };

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const li = (...content: unknown[]) => ({ type: "listItem", content });
const ul = (...items: unknown[]) => ({ type: "bulletList", content: items });
const strong = { type: "strong" };
const em = { type: "em" };
const strike = { type: "strike" };
const code = { type: "code" };
const link = (href: string, title?: string) => ({ type: "link", attrs: { href, ...(title ? { title } : {}) } });
const br = { type: "hardBreak" };
const file = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "media",
  attrs: { type: "file", id, collection: "", ...extra },
});
const cell = (type: string, ...content: unknown[]) => ({ type, content: [p(...content)] });
const task = (state: string, ...content: unknown[]) => ({ type: "taskItem", attrs: { localId: "t", state }, content });

const context = { issueUrl: "https://acme.atlassian.net/browse/ABC-1" };

/** Drops what only identifies a node or repeats a default, which changes nothing a reader sees. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const nodes = value.map(normalize) as Node[];
    // Text side by side with the same marks is one text.
    const merged: Node[] = [];
    for (const node of nodes) {
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
  delete attrs.uniqueId;
  if (node.type === "mention") {
    delete attrs.accessLevel;
    delete attrs.userType;
  }
  if (node.type === "hardBreak") delete attrs.text;
  if (node.type === "orderedList" && attrs.order === 1) delete attrs.order;
  if (node.type === "table") {
    if (attrs.isNumberColumnEnabled === false) delete attrs.isNumberColumnEnabled;
    if (["default", "center"].includes(attrs.layout as string)) delete attrs.layout;
    if (attrs.width === 760) delete attrs.width;
    if (attrs.displayMode === "default") delete attrs.displayMode;
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    if (attrs.colspan === 1) delete attrs.colspan;
    if (attrs.rowspan === 1) delete attrs.rowspan;
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

function writtenBack(value: unknown) {
  return markdownToAdf(adfToMarkdown(value, context) ?? "");
}

describe("what the reader keeps comes back as the same ADF", () => {
  it.each([
    ["plain text with inner spaces, tabs and non-breaking spaces", doc(p(text("a  b\tc  d")), p(text(" edge ")))],
    ["hard breaks, an empty line between lines, and a leading one", doc(p(text("a"), br, text("b"), br, br, text("c")), p(br, text("d")))],
    ["bold, italic, strikethrough and code", doc(p(text("a", [strong]), text(" "), text("b", [em]), text(" "), text("c", [strike]), text(" "), text("d", [code])))],
    ["emphasis nested and inside a word", doc(p(text("un"), text("b", [em]), text("c", [em, strong]), text("d", [em]), text("able")))],
    ["emphasis around a mention and a hard break", doc(p(text("a", [strong]), { type: "mention", attrs: { id: "1", text: "@A" } }, text("b", [strong]), br, text("c", [strong])))],
    ["links, with a title, emphasis inside and spaces at their edges", doc(p(text(" a ", [link("https://e.com/x_(y)", "T \"1\"")]), text("b", [link("https://e.com/x_(y)", "T \"1\""), em]), text(" "), text("c", [link("mailto:a@b.c")]), text(" "), text("d", [code, link("https://e.com/?a=1&b=2")])))],
    ["a link whose address has spaces and an entity-like part", doc(p(text("x", [link("https://e.com/a b&amp;c")])))],
    ["mentions", doc(p(text("ask "), { type: "mention", attrs: { id: "557058:ab-cd", text: "@Ana [PM] *x*", accessLevel: "", userType: "DEFAULT" } }))],
    ["smart links", doc(p({ type: "inlineCard", attrs: { url: "https://e.com/browse/ABC-1" } }))],
    ["characters Markdown reads as syntax", doc(p(text("# *a* _b_ [c] <d> &amp; &#65; e|f ~g~ `h` \\i !")), p(text("1. x")), p(text("- y")), p(text("+")), p(text("> z")), p(text("===")), p(text("2)")))],
    ["headings of each level, and an empty one", doc(...[1, 2, 3, 4, 5, 6].map((level) => ({ type: "heading", attrs: { level }, content: [text(`H${level} #`)] })), { type: "heading", attrs: { level: 2 } })],
    ["rules", doc(p(text("a")), { type: "rule" }, p(text("b")))],
    ["quotes holding paragraphs, lists, code and images", doc({ type: "blockquote", content: [p(text("a")), ul(li(p(text("b")))), { type: "codeBlock", content: [text("c")] }, { type: "mediaSingle", attrs: { layout: "center" }, content: [file("q")] }] })],
    ["lists from 0 and from 5, nested, with paragraphs and code in items, and an empty item", doc({ type: "orderedList", attrs: { order: 0 }, content: [li(p(text("a")), p(text("a2")), { type: "orderedList", attrs: { order: 5 }, content: [li(p(text("b")))] }), li(p()), li(p(text("c")), { type: "codeBlock", attrs: { language: "sh" }, content: [text("x\n\n  y")] })] })],
    ["two lists side by side", doc(ul(li(p(text("a")))), ul(li(p(text("b")))))],
    ["task lists, nested, done and open, and an empty item", doc({ type: "taskList", attrs: { localId: "l" }, content: [task("DONE", text("a")), { type: "taskList", attrs: { localId: "m" }, content: [task("TODO", text("b"))] }, task("TODO")] })],
    ["code blocks with a language, backticks, tabs, trailing blank lines, and none", doc({ type: "codeBlock", attrs: { language: "ts" }, content: [text("\tconst a = `b`;  \n```\n\n")] }, { type: "codeBlock" })],
    ["tables with a header row, code with a pipe, an empty cell and a mention", doc({ type: "table", attrs: { isNumberColumnEnabled: false, layout: "center", width: 760 }, content: [{ type: "tableRow", content: [cell("tableHeader", text("A", [strong])), cell("tableHeader", text("b|c", [code]))] }, { type: "tableRow", content: [cell("tableCell", { type: "mention", attrs: { id: "1", text: "@A" } }), { type: "tableCell", content: [p()] }] }] })],
    ["images, their size and place", doc({ type: "mediaSingle", attrs: { layout: "wrap-left", width: 40, widthType: "percentage" }, content: [file("f1", { alt: "a.png", width: 10, height: 20, occurrenceKey: "o" })] })],
    ["file cards in a group", doc({ type: "mediaGroup", content: [file("f2", { alt: "a.pdf" }), file("f3")] })],
    ["inline files", doc(p(text("see "), { type: "mediaInline", attrs: { id: "f4", collection: "", type: "image" } }))],
    ["images on the web", doc({ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "external", url: "https://i.e/a (1).png", alt: "Logo" } }] })],
  ])("keeps %s", (_name, value) => {
    expect(adfToMarkdownWithLosses(value, context).lost).toEqual([]);
    expect(normalize(writtenBack(value))).toEqual(normalize(value));
  });
});

describe("what the reader cannot keep is named", () => {
  it.each([
    ["spaces at a line's start", doc(p(text("  indented"))), ["spacing"]],
    ["spaces at a line's end", doc(p(text("trailing "))), ["spacing"]],
    ["spaces before a hard break", doc(p(text("a "), br, text("b"))), ["spacing"]],
    ["spaces after a hard break", doc(p(text("a"), br, text(" b"))), ["spacing"]],
    ["spaces at a heading's edges", doc({ type: "heading", attrs: { level: 1 }, content: [text(" a ")] }), ["spacing"]],
    ["spaces at a table cell's edges", doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", text(" a "))] }] }), ["spacing"]],
    ["emphasis on spaces at its edge", doc(p(text("bold ", [strong]), text("next"))), ["formatting on spaces"]],
    ["emphasis on spaces alone", doc(p(text("a"), text(" ", [strike]), text("b"))), ["formatting on spaces"]],
    ["hard breaks at a paragraph's end", doc(p(text("a"), br)), ["empty lines"]],
    ["empty paragraphs inside a quote", doc({ type: "blockquote", content: [p(text("a")), p(), p(text("b"))] }), ["empty lines"]],
    ["empty paragraphs inside a list item", doc(ul(li(p(text("a")), p()))), ["empty lines"]],
    ["line breaks inside text", doc(p(text("a\nb"))), ["other formatting"]],
    ["line breaks inside code text", doc(p(text("a\nb", [code]))), ["other formatting"]],
    ["line breaks in headings", doc({ type: "heading", attrs: { level: 1 }, content: [text("a"), br, text("b")] }), ["line breaks in headings"]],
    ["emoji", doc(p({ type: "emoji", attrs: { shortName: ":smile:", id: "1f604", text: "😄" } })), ["emoji"]],
    ["a mention without its @ name", doc(p({ type: "mention", attrs: { id: "1" } })), ["other formatting"]],
    ["dates", doc(p({ type: "date", attrs: { timestamp: "0" } })), ["dates"]],
    ["status lozenges", doc(p({ type: "status", attrs: { text: "OK", color: "green" } })), ["status lozenges"]],
    ["smart links without an address", doc(p({ type: "inlineCard", attrs: { data: {} } })), ["other formatting", "link previews"]],
    ["block and embedded link cards", doc({ type: "blockCard", attrs: { url: "https://e.com" } }), ["link previews"]],
    ["panels", doc({ type: "panel", attrs: { panelType: "info" }, content: [p(text("a"))] }), ["panels"]],
    ["expand sections", doc({ type: "expand", attrs: { title: "T" }, content: [p(text("a"))] }), ["expand sections"]],
    ["decisions", doc({ type: "decisionList", attrs: { localId: "d" }, content: [{ type: "decisionItem", attrs: { localId: "i", state: "DECIDED" }, content: [text("a")] }] }), ["decisions"]],
    ["app content", doc({ type: "bodiedExtension", attrs: { extensionKey: "k", extensionType: "t" }, content: [p(text("a"))] }), ["app content"]],
    ["page layouts", doc({ type: "layoutSection", content: [{ type: "layoutColumn", attrs: { width: 50 }, content: [p(text("a"))] }] }), ["other formatting"]],
    ["a code block's language with a space", doc({ type: "codeBlock", attrs: { language: "a b" }, content: [text("x")] }), ["other formatting"]],
    ["a code block's display settings", doc({ type: "codeBlock", attrs: { wrap: true }, content: [text("x")] }), ["other formatting"]],
    ["wide blocks", doc({ type: "codeBlock", marks: [{ type: "breakout", attrs: { mode: "wide" } }], content: [text("x")] }), ["wide blocks"]],
    ["text colour", doc(p(text("a", [{ type: "textColor", attrs: { color: "#ff0000" } }]))), ["text colour"]],
    ["highlight", doc(p(text("a", [{ type: "backgroundColor", attrs: { color: "#ffff00" } }]))), ["highlight"]],
    ["underline", doc(p(text("a", [{ type: "underline" }]))), ["underline"]],
    ["superscript", doc(p(text("a", [{ type: "subsup", attrs: { type: "sup" } }]))), ["superscript"]],
    ["subscript", doc(p(text("a", [{ type: "subsup", attrs: { type: "sub" } }]))), ["subscript"]],
    ["inline comments", doc(p(text("a", [{ type: "annotation", attrs: { id: "x", annotationType: "inlineComment" } }]))), ["inline comments"]],
    ["emphasis on code", doc(p(text("a", [code, strong]))), ["emphasis on code"]],
    ["a link's other attributes", doc(p(text("a", [{ type: "link", attrs: { href: "https://e.com", id: "x" } }]))), ["other formatting"]],
    ["text alignment", doc({ type: "paragraph", marks: [{ type: "alignment", attrs: { align: "center" } }], content: [text("a")] }), ["text alignment"]],
    ["indentation", doc({ type: "paragraph", marks: [{ type: "indentation", attrs: { level: 1 } }], content: [text("a")] }), ["indentation"]],
    ["font size", doc({ type: "paragraph", marks: [{ type: "fontSize", attrs: { fontSize: "small" } }], content: [text("a")] }), ["font size"]],
    ["an invalid list start", doc({ type: "orderedList", attrs: { order: 1.5 }, content: [li(p(text("a")))] }), ["other formatting"]],
    ["a task list starting with a nested one", doc({ type: "taskList", attrs: { localId: "l" }, content: [{ type: "taskList", attrs: { localId: "m" }, content: [task("TODO", text("a"))] }] }), ["other formatting"]],
    ["table header cells outside the first row", doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableCell", text("a"))] }] }), ["table header cells"]],
    ["merged table cells", doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [p(text("a"))] }] }] }), ["merged table cells"]],
    ["column widths", doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colwidth: [100] }, content: [p(text("a"))] }] }] }), ["column widths"]],
    ["cell colours", doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { background: "#eeeeee" }, content: [p(text("a"))] }] }] }), ["cell colours"]],
    ["table width", doc({ type: "table", attrs: { layout: "wide" }, content: [{ type: "tableRow", content: [cell("tableHeader", text("a"))] }] }), ["table width"]],
    ["numbered table rows", doc({ type: "table", attrs: { isNumberColumnEnabled: true }, content: [{ type: "tableRow", content: [cell("tableHeader", text("a"))] }] }), ["numbered table rows"]],
    ["blocks in table cells", doc({ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [p(text("a")), p(text("b"))] }] }] }), ["blocks in table cells"]],
    ["line breaks in table cells", doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", text("a"), br, text("b"))] }] }), ["line breaks in table cells"]],
    ["a backslash before a pipe in a table cell's code", doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", text("a\\|b", [code]))] }] }), ["other formatting"]],
    ["rows of different lengths", doc({ type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", text("a")), cell("tableHeader", text("b"))] }, { type: "tableRow", content: [cell("tableCell", text("c"))] }] }), ["other formatting"]],
    ["image captions", doc({ type: "mediaSingle", attrs: { layout: "center" }, content: [file("f"), { type: "caption", content: [text("c")] }] }), ["image captions"]],
    ["image borders", doc({ type: "mediaSingle", attrs: { layout: "center" }, content: [{ ...file("f"), marks: [{ type: "border", attrs: { size: 1, color: "#000000" } }] }] }), ["image borders"]],
    ["linked images", doc({ type: "mediaSingle", attrs: { layout: "center" }, marks: [link("https://e.com")], content: [file("f")] }), ["linked images"]],
    ["web images in a group", doc({ type: "mediaGroup", content: [{ type: "media", attrs: { type: "external", url: "https://i.e/a.png" } }] }), ["other formatting"]],
    ["unknown nodes, marks and attributes", doc(p(text("a", [{ type: "sparkle" }])), { type: "rule", attrs: { glow: true } }), ["other formatting"]],
  ])("names %s", (_name, value, lost) => {
    const result = adfToMarkdownWithLosses(value, context);
    expect(result.lost).toEqual(lost);
    // The text Ajour shows writes back as itself, so only the named loss goes.
    expect(adfToMarkdown(markdownToAdf(result.markdown ?? ""), context) ?? "").toBe(result.markdown ?? "");
  });

  it.each([
    ["marks that overlap without nesting", doc(p(text("un"), text("b", [em]), text("c", [em, strong]), text("d", [strong])))],
    ["emphasis that cannot flank its text", doc(p(text("a"), text("\"x\"", [strong]), text("b")))],
  ])("names %s, whose Markdown would not write back as itself", (_name, value) => {
    expect(describeJiraDescription(value, context).lost).toEqual([NOT_WRITABLE_EXACTLY]);
  });
});
