import { describe, expect, it } from "vitest";
import { adfToMarkdown, adfToMarkdownWithLosses } from "../src/adf-markdown.ts";
import { markdownToAdf } from "../src/markdown-adf.ts";

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const listItem = (...content: unknown[]) => ({ type: "listItem", content });
const bulletList = (...content: unknown[]) => ({ type: "bulletList", content });
const strong = { type: "strong" };
const em = { type: "em" };
const link = (href: string) => ({ type: "link", attrs: { href } });

const ISSUE_URL = "https://acme.atlassian.net/browse/ABC-1";
const SHOT_URL = "https://acme.atlassian.net/rest/api/3/attachment/content/10010";
const context = {
  issueUrl: ISSUE_URL,
  attachments: [{ filename: "shot.png", content: SHOT_URL }],
};

function lostOf(value: unknown) {
  return adfToMarkdownWithLosses(value, context).lost;
}

describe("adfToMarkdown", () => {
  it("returns nothing for an empty or missing description", () => {
    expect(adfToMarkdown(undefined)).toBeUndefined();
    expect(adfToMarkdown(null)).toBeUndefined();
    expect(adfToMarkdown(doc())).toBeUndefined();
    expect(adfToMarkdown(doc(paragraph()))).toBeUndefined();
  });

  it("keeps a plain string description", () => {
    expect(adfToMarkdown("  Plain text  ")).toBe("Plain text");
  });

  it("separates paragraphs and keeps hard breaks as newlines", () => {
    expect(
      adfToMarkdown(doc(paragraph(text("First"), { type: "hardBreak" }, text("line")), paragraph(text("Second")))),
    ).toBe("First\nline\n\nSecond");
  });

  it("renders text marks", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text("bold ", [strong]),
            text("italic", [em]),
            text(" "),
            text("gone", [{ type: "strike" }]),
            text(" "),
            text("a `tick`", [{ type: "code" }]),
            text(" "),
            text("spec", [link("https://example.com/a b")]),
          ),
        ),
      ),
    ).toBe("**bold** *italic* ~~gone~~ `` a `tick` `` [spec](<https://example.com/a b>)");
  });

  it("opens each mark once across the text it covers", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text("a", [strong]),
            text("b", [strong, em]),
            text("c", [strong]),
            text(" see ", [link("https://example.com")]),
            text("here", [link("https://example.com"), strong]),
          ),
        ),
      ),
    ).toBe("**a*b*c**[ see **here**](https://example.com)");
  });

  it("keeps a link's title and the characters of its address", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text("wiki", [{ type: "link", attrs: { href: "https://example.com/a_(b)", title: 'The "page"' } }]),
          ),
        ),
      ),
    ).toBe('[wiki](https://example.com/a_\\(b\\) "The \\"page\\"")');
  });

  it("escapes characters markdown would read as syntax", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(text("# not a heading")),
          paragraph(text("snake_case and *stars* [x] <b> &amp; a|b ~x~")),
          paragraph(text("1. not a list"), { type: "hardBreak" }, text("- nor this"), { type: "hardBreak" }, text("---")),
          paragraph(text("Wow!"), text("link", [link("https://example.com")])),
        ),
      ),
    ).toBe(
      "\\# not a heading\n\nsnake\\_case and \\*stars\\* \\[x\\] \\<b> \\&amp; a\\|b \\~x\\~\n\n1\\. not a list\n\\- nor this\n\\---\n\nWow\\![link](https://example.com)",
    );
  });

  it("renders headings, rules and quotes", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "heading", attrs: { level: 2 }, content: [text("Context #")] },
          { type: "rule" },
          { type: "blockquote", content: [paragraph(text("Quoted")), paragraph(text("Twice"))] },
        ),
      ),
    ).toBe("## Context \\#\n\n---\n\n> Quoted\n>\n> Twice");
  });

  it("renders bullet, ordered and nested lists, and an item's paragraphs apart", () => {
    expect(
      adfToMarkdown(
        doc(
          bulletList(
            listItem(paragraph(text("One")), {
              type: "orderedList",
              attrs: { order: 3 },
              content: [listItem(paragraph(text("Three"))), listItem(paragraph(text("Four")), paragraph(text("More")))],
            }),
            listItem(paragraph(text("Two"))),
          ),
        ),
      ),
    ).toBe("- One\n\n  3. Three\n  4. Four\n\n     More\n- Two");
  });

  it("renders task lists, nested ones under their item", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "taskList",
          attrs: { localId: "l1" },
          content: [
            { type: "taskItem", attrs: { localId: "t1", state: "DONE" }, content: [text("Done")] },
            {
              type: "taskList",
              attrs: { localId: "l2" },
              content: [{ type: "taskItem", attrs: { localId: "t2", state: "TODO" }, content: [text("Sub")] }],
            },
            { type: "taskItem", attrs: { localId: "t3", state: "TODO" }, content: [text("Open")] },
          ],
        }),
      ),
    ).toBe("- [x] Done\n  - [ ] Sub\n- [ ] Open");
  });

  it("fences code blocks with their language, keeping their lines", () => {
    expect(
      adfToMarkdown(
        doc({ type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = `b`;\n```\n\n")] }),
      ),
    ).toBe("````ts\nconst a = `b`;\n```\n\n\n````");
  });

  it("renders tables with the header row first", () => {
    const cell = (type: string, value: string) => ({ type, content: [paragraph(text(value))] });
    expect(
      adfToMarkdown(
        doc({
          type: "table",
          attrs: { isNumberColumnEnabled: false, layout: "default", localId: "x" },
          content: [
            { type: "tableRow", content: [cell("tableHeader", "Day"), cell("tableHeader", "Hours")] },
            { type: "tableRow", content: [cell("tableCell", "Mon"), cell("tableCell", "7|5")] },
          ],
        }),
      ),
    ).toBe("| Day | Hours |\n| --- | --- |\n| Mon | 7\\|5 |");
  });

  it("renders mentions as Ajour mentions, and emoji, smart links, dates and statuses as text", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            { type: "mention", attrs: { id: "557058:abc", text: "@Sam [PM]", accessLevel: "" } },
            text(" "),
            { type: "emoji", attrs: { shortName: ":smile:", id: "1f604", text: "😄" } },
            text(" "),
            { type: "inlineCard", attrs: { url: "https://example.com/card" } },
            text(" "),
            { type: "date", attrs: { timestamp: "1760400000000" } },
            text(" "),
            { type: "status", attrs: { text: "BLOCKED", color: "red" } },
          ),
        ),
      ),
    ).toBe("[@Sam \\[PM\\]](mention:557058:abc) 😄 <https://example.com/card> 2025-10-14 BLOCKED");
  });

  it("keeps images as Markdown images whose address carries what Jira needs", () => {
    const media = (id: string, alt?: string) => ({
      type: "media",
      attrs: { type: "file", id, collection: "", ...(alt ? { alt } : {}), width: 800, height: 600 },
    });
    const result = adfToMarkdownWithLosses(
      doc(
        { type: "mediaSingle", attrs: { layout: "center" }, content: [media("f1", "shot.png")] },
        { type: "mediaSingle", attrs: { layout: "wide", width: 50 }, content: [media("f2")] },
        { type: "mediaGroup", content: [media("f3", "a.pdf"), media("f4", "b.pdf")] },
        {
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{ type: "media", attrs: { type: "external", url: "https://img.example/a.png", alt: "Logo" } }],
        },
        paragraph(text("See "), { type: "mediaInline", attrs: { id: "f5", collection: "", type: "file" } }),
      ),
      context,
    );
    expect(result).toEqual({
      markdown: [
        `![shot.png](${SHOT_URL}#ajour-media?id=f1&collection=&width=800&height=600)`,
        `![](${ISSUE_URL}#ajour-media?id=f2&collection=&width=800&height=600&layout=wide&size=50)`,
        `![a.pdf](${ISSUE_URL}#ajour-media?id=f3&collection=&width=800&height=600&group=)\n` +
          `![b.pdf](${ISSUE_URL}#ajour-media?id=f4&collection=&width=800&height=600&group=)`,
        "![Logo](https://img.example/a.png)",
        `See ![](${ISSUE_URL}#ajour-media?id=f5&collection=&type=file&inline=)`,
      ].join("\n\n"),
      lost: [],
    });
  });
});

describe("adfToMarkdownWithLosses", () => {
  it("loses nothing for what Markdown holds", () => {
    expect(
      lostOf(
        doc(
          { type: "heading", attrs: { level: 1, localId: "h" }, content: [text("Plan", [strong])] },
          paragraph(text("a", [em]), text("b", [{ type: "strike" }]), { type: "mention", attrs: { id: "1", text: "@A" } }),
          bulletList(listItem(paragraph(text("x")))),
          { type: "codeBlock", attrs: { language: "js", uniqueId: "u" }, content: [text("x")] },
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ["text colour", paragraph(text("red", [{ type: "textColor", attrs: { color: "#ff0000" } }]))],
    ["highlight", paragraph(text("hi", [{ type: "backgroundColor", attrs: { color: "#ffff00" } }]))],
    ["underline", paragraph(text("u", [{ type: "underline" }]))],
    ["superscript", paragraph(text("2", [{ type: "subsup", attrs: { type: "sup" } }]))],
    ["subscript", paragraph(text("2", [{ type: "subsup", attrs: { type: "sub" } }]))],
    ["inline comments", paragraph(text("c", [{ type: "annotation", attrs: { id: "a", annotationType: "inlineComment" } }]))],
    ["text alignment", { ...paragraph(text("c")), marks: [{ type: "alignment", attrs: { align: "center" } }] }],
    ["indentation", { ...paragraph(text("c")), marks: [{ type: "indentation", attrs: { level: 1 } }] }],
    ["font size", { ...paragraph(text("c")), marks: [{ type: "fontSize", attrs: { fontSize: "small" } }] }],
    ["panels", { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("Note"))] }],
    ["expand sections", { type: "expand", attrs: { title: "More" }, content: [paragraph(text("Body"))] }],
    ["status lozenges", paragraph({ type: "status", attrs: { text: "DONE", color: "green" } })],
    ["dates", paragraph({ type: "date", attrs: { timestamp: "1760400000000" } })],
    ["emoji", paragraph({ type: "emoji", attrs: { shortName: ":smile:", id: "1f604", text: "😄" } })],
    ["emoji", paragraph({ type: "emoji", attrs: { shortName: ":party-parrot:", id: "abc" } })],
    [
      "decisions",
      { type: "decisionList", attrs: { localId: "d" }, content: [{ type: "decisionItem", attrs: { localId: "i", state: "DECIDED" }, content: [text("Go")] }] },
    ],
    ["link previews", { type: "blockCard", attrs: { url: "https://example.com" } }],
    ["wide blocks", { type: "codeBlock", marks: [{ type: "breakout", attrs: { mode: "wide" } }], content: [text("x")] }],
    ["app content", { type: "extension", attrs: { extensionType: "com.app", extensionKey: "macro" } }],
    [
      "image captions",
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [
          { type: "media", attrs: { type: "file", id: "f", collection: "" } },
          { type: "caption", content: [text("Cap")] },
        ],
      },
    ],
    [
      "image borders",
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [{ type: "media", attrs: { type: "file", id: "f", collection: "" }, marks: [{ type: "border", attrs: { size: 2, color: "#000000" } }] }],
      },
    ],
    [
      "linked images",
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [{ type: "media", attrs: { type: "file", id: "f", collection: "" }, marks: [link("https://example.com")] }],
      },
    ],
    ["line breaks in headings", { type: "heading", attrs: { level: 2 }, content: [text("a"), { type: "hardBreak" }, text("b")] }],
    ["spacing", paragraph(text("    indented"))],
    ["empty lines", { type: "blockquote", content: [paragraph(text("a")), paragraph(), paragraph(text("b"))] }],
    ["other formatting", { type: "layoutSection", content: [{ type: "layoutColumn", attrs: { width: 50 }, content: [paragraph(text("x"))] }] }],
    ["other formatting", paragraph(text("x", [{ type: "sparkle" }]))],
    ["other formatting", { type: "codeBlock", attrs: { language: "js", wrap: true }, content: [text("x")] }],
    ["emphasis on code", paragraph(text("x", [{ type: "code" }, strong]))],
  ])("names %s", (name, node) => {
    expect(lostOf(doc(node))).toContain(name);
  });

  it.each([
    ["table header cells", [["tableCell", "tableCell"], ["tableCell", "tableCell"]]],
    ["table header cells", [["tableHeader", "tableCell"], ["tableHeader", "tableCell"]]],
  ])("names %s in a table without one header row", (name, layout) => {
    const table = {
      type: "table",
      content: layout.map((row) => ({
        type: "tableRow",
        content: row.map((type) => ({ type, content: [paragraph(text("x"))] })),
      })),
    };
    expect(lostOf(doc(table))).toEqual([name]);
  });

  it.each([
    ["merged table cells", { colspan: 2 }, undefined],
    ["column widths", { colwidth: [120] }, undefined],
    ["cell colours", { background: "#eeeeee" }, undefined],
    ["blocks in table cells", {}, [paragraph(text("a")), paragraph(text("b"))]],
    ["line breaks in table cells", {}, [paragraph(text("a"), { type: "hardBreak" }, text("b"))]],
  ])("names %s", (name, attrs, content) => {
    const table = {
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader", attrs, content: content ?? [paragraph(text("x"))] }] },
      ],
    };
    expect(lostOf(doc(table))).toEqual([name]);
  });

  it.each([
    ["table width", { layout: "full-width" }],
    ["table width", { width: 1200 }],
    ["numbered table rows", { isNumberColumnEnabled: true }],
  ])("names %s", (name, attrs) => {
    const table = {
      type: "table",
      attrs,
      content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("x"))] }] }],
    };
    expect(lostOf(doc(table))).toEqual([name]);
  });

  it("names nothing for a table at Jira's default width", () => {
    const table = {
      type: "table",
      attrs: { isNumberColumnEnabled: false, layout: "center", width: 760, displayMode: "default", localId: "t" },
      content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1, rowspan: 1 }, content: [paragraph()] }] }],
    };
    expect(lostOf(doc(table))).toEqual([]);
  });

  it("never names images or mentions as lost", () => {
    expect(
      lostOf(
        doc(
          { type: "mediaSingle", attrs: { layout: "wrap-left", width: 30, widthType: "percentage" }, content: [{ type: "media", attrs: { type: "file", id: "f", collection: "c", width: 10, height: 10 } }] },
          paragraph({ type: "mention", attrs: { id: "1", text: "@Ana", accessLevel: "CONTAINER", userType: "DEFAULT" } }),
        ),
      ),
    ).toEqual([]);
  });
});

/** ADF → Markdown → ADF → Markdown, which must give the same Markdown. */
function roundTrip(value: unknown) {
  const first = adfToMarkdown(value, context) ?? "";
  const second = adfToMarkdown(markdownToAdf(first), context) ?? "";
  return { first, second };
}

describe("ADF → Markdown → ADF → Markdown", () => {
  const cell = (type: string, ...content: unknown[]) => ({ type, content: [paragraph(...content)] });
  const media = (id: string) => ({ type: "media", attrs: { type: "file", id, collection: "", alt: `${id}.png`, width: 4, height: 3 } });

  it.each([
    ["paragraphs and breaks", doc(paragraph(text("a"), { type: "hardBreak" }, text("b")), paragraph(text("c")))],
    ["emphasis", doc(paragraph(text("a", [strong]), text("b", [strong, em]), text(" c ", [em]), text("d", [{ type: "strike" }])))],
    ["emphasis inside words", doc(paragraph(text("un"), text("break", [em]), text("able")))],
    ["code", doc(paragraph(text("x"), text("``a`", [{ type: "code" }]), text(" "), text(" b ", [{ type: "code" }])))],
    ["links", doc(paragraph(text("a ", [link("https://e.com/x_(y)")]), text("b", [link("https://e.com/x_(y)"), strong]), text(" c", [link("mailto:a@b.c")])))],
    ["link titles", doc(paragraph(text("a", [{ type: "link", attrs: { href: "https://e.com", title: "T (1)" } }])))],
    ["code in links", doc(paragraph(text("x", [link("https://e.com"), { type: "code" }])))],
    ["mentions", doc(paragraph(text("hi "), { type: "mention", attrs: { id: "5b10:ac", text: "@Ana [x] *y*" } }))],
    ["smart links", doc(paragraph({ type: "inlineCard", attrs: { url: "https://e.com/a?b=c&d" } }))],
    ["escapes", doc(paragraph(text("# a *b* _c_ [d] <e> &amp; f|g ~h~ `i` \\j 1. k - l !")), paragraph(text("+")), paragraph(text("2)")), paragraph(text("===")))],
    ["exclamation before a link", doc(paragraph(text("!"), text("x", [link("https://e.com")])))],
    ["headings", doc({ type: "heading", attrs: { level: 3 }, content: [text("Title #", [em])] }, { type: "heading", attrs: { level: 1 } })],
    ["rules", doc(paragraph(text("a")), { type: "rule" }, paragraph(text("b")))],
    ["quotes", doc({ type: "blockquote", content: [paragraph(text("a")), bulletList(listItem(paragraph(text("b")))), { type: "codeBlock", content: [text("c")] }] })],
    [
      "lists",
      doc(
        bulletList(
          listItem(paragraph(text("a")), paragraph(text("a2")), { type: "orderedList", attrs: { order: 9 }, content: [listItem(paragraph(text("b"))), listItem(paragraph(text("c")))] }),
          listItem(paragraph()),
          listItem(paragraph(text("d")), { type: "codeBlock", attrs: { language: "sh" }, content: [text("x\n\n  y")] }),
        ),
      ),
    ],
    ["two lists", doc(bulletList(listItem(paragraph(text("a")))), bulletList(listItem(paragraph(text("b")))))],
    [
      "task lists",
      doc({
        type: "taskList",
        attrs: { localId: "l" },
        content: [
          { type: "taskItem", attrs: { localId: "a", state: "DONE" }, content: [text("a", [strong])] },
          { type: "taskList", attrs: { localId: "m" }, content: [{ type: "taskItem", attrs: { localId: "b", state: "TODO" }, content: [text("b")] }] },
          { type: "taskItem", attrs: { localId: "c", state: "TODO" } },
        ],
      }),
    ],
    ["code blocks", doc({ type: "codeBlock", attrs: { language: "py" }, content: [text("```\n\nx\n")] }, { type: "codeBlock" })],
    [
      "tables",
      doc({
        type: "table",
        content: [
          { type: "tableRow", content: [cell("tableHeader", text("A", [strong])), cell("tableHeader", text("B|`", [{ type: "code" }]))] },
          { type: "tableRow", content: [cell("tableCell", text("1")), { type: "tableCell", content: [paragraph()] }] },
        ],
      }),
    ],
    ["images", doc({ type: "mediaSingle", attrs: { layout: "align-start", width: 300, widthType: "pixel" }, content: [media("f1")] }, { type: "mediaGroup", content: [media("f2"), media("f3")] }, paragraph(text("x "), { type: "mediaInline", attrs: { id: "f4", collection: "", type: "image" } }))],
    ["external images", doc({ type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "external", url: "https://i.e/a (1).png", width: 5 } }] })],
    ["empty paragraphs between blocks", doc(paragraph(), paragraph(text("a")), paragraph(), paragraph(), paragraph(text("b")), paragraph())],
  ])("keeps %s", (_name, value) => {
    const { first, second } = roundTrip(value);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it.each([
    ["panels", doc({ type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("Note"))] })],
    ["expand sections", doc({ type: "expand", attrs: { title: "More" }, content: [paragraph(text("Body"))] })],
    ["status lozenges", doc(paragraph({ type: "status", attrs: { text: "DONE", color: "green" } }))],
    ["dates", doc(paragraph({ type: "date", attrs: { timestamp: "1760400000000" } }))],
    ["emoji", doc(paragraph({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }))],
    ["underline", doc(paragraph(text("u", [{ type: "underline" }])))],
    ["text colour", doc(paragraph(text("r", [{ type: "textColor", attrs: { color: "#ff0000" } }])))],
  ])("reads %s, a loss, as Markdown that writes back as itself", (_name, value) => {
    const { first, second } = roundTrip(value);
    expect(second).toBe(first);
  });
});
