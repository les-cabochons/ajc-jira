import { describe, expect, it } from "vitest";
import { markdownToAdf } from "../src/markdown-adf.ts";

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => (content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const listItem = (...content: unknown[]) => ({ type: "listItem", content });
const strong = { type: "strong" };
const em = { type: "em" };
const code = { type: "code" };
const link = (href: string, title?: string) => ({ type: "link", attrs: { href, ...(title ? { title } : {}) } });

describe("markdownToAdf", () => {
  it("writes an empty document for empty Markdown", () => {
    expect(markdownToAdf("")).toEqual(doc());
    expect(markdownToAdf("\n  \n")).toEqual(doc());
  });

  it("writes paragraphs, keeping each line break as a hard break", () => {
    expect(markdownToAdf("First\nline\\\nthird  \n\nSecond")).toEqual(
      doc(
        paragraph(text("First"), { type: "hardBreak" }, text("line"), { type: "hardBreak" }, text("third")),
        paragraph(text("Second")),
      ),
    );
  });

  it("writes emphasis as CommonMark pairs it", () => {
    expect(markdownToAdf("**a*b*c** _d_ ~~e~~ ~f~ un*break*able snake_case_name **x")).toEqual(
      doc(
        paragraph(
          text("a", [strong]),
          text("b", [strong, em]),
          text("c", [strong]),
          text(" "),
          text("d", [em]),
          text(" "),
          text("e", [{ type: "strike" }]),
          text(" "),
          text("f", [{ type: "strike" }]),
          text(" un"),
          text("break", [em]),
          text("able snake_case_name **x"),
        ),
      ),
    );
  });

  it("writes code spans without the emphasis around them, which Jira does not allow on code", () => {
    expect(markdownToAdf("**a `b` c** `` x`y ``")).toEqual(
      doc(paragraph(text("a ", [strong]), text("b", [code]), text(" c", [strong]), text(" "), text("x`y", [code]))),
    );
  });

  it("writes links with their titles, and keeps an unsafe link's text only", () => {
    expect(
      markdownToAdf(
        '[a **b**](https://e.com/x_\\(y\\) "T") [c](<https://e.com/a b>) [d](javascript:alert(1)) [`e`](https://e.com)',
      ),
    ).toEqual(
      doc(
        paragraph(
          text("a ", [link("https://e.com/x_(y)", "T")]),
          text("b", [strong, link("https://e.com/x_(y)", "T")]),
          text(" "),
          text("c", [link("https://e.com/a b")]),
          text(" d "),
          text("e", [code, link("https://e.com")]),
        ),
      ),
    );
  });

  it("writes autolinks as smart links", () => {
    expect(markdownToAdf("See <https://e.com/a?b=1>")).toEqual(
      doc(paragraph(text("See "), { type: "inlineCard", attrs: { url: "https://e.com/a?b=1" } })),
    );
  });

  it("writes Ajour mentions as Jira mentions", () => {
    expect(markdownToAdf("Ask [@Ana \\[PM\\]](mention:557058:abc-123) now")).toEqual(
      doc(
        paragraph(
          text("Ask "),
          { type: "mention", attrs: { id: "557058:abc-123", text: "@Ana [PM]" } },
          text(" now"),
        ),
      ),
    );
  });

  it("decodes escapes and character references", () => {
    expect(markdownToAdf("\\*a\\* &amp; &lt;b&gt; &#65; &copy; \\<c> <d>")).toEqual(
      doc(paragraph(text("*a* & <b> A &copy; <c> <d>"))),
    );
  });

  it("writes headings, rules and code blocks", () => {
    expect(markdownToAdf("## Plan *now* ##\n\n---\n\n```ts\nconst a = 1;\n\n```\n\n    indented\n\nSetext\n===")).toEqual(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Plan "), text("now", [em])] },
        { type: "rule" },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;\n")] },
        { type: "codeBlock", content: [text("indented")] },
        { type: "heading", attrs: { level: 1 }, content: [text("Setext")] },
      ),
    );
  });

  it("writes quotes, with only the blocks Jira allows in them", () => {
    expect(markdownToAdf("> a\n>\n> # b\n> > c\n>\n> - d")).toEqual(
      doc({
        type: "blockquote",
        content: [
          paragraph(text("a")),
          paragraph(text("b")),
          paragraph(text("c")),
          { type: "bulletList", content: [listItem(paragraph(text("d")))] },
        ],
      }),
    );
  });

  it("writes lists, nested lists and an item's paragraphs, and a blank line ends a list", () => {
    // An ordered list from 3 cannot interrupt a paragraph, so a blank line comes first.
    expect(markdownToAdf("- a\n\n  a2\n\n  3. b\n  4. c\n-\n\n* e\n\n1) f")).toEqual(
      doc(
        {
          type: "bulletList",
          content: [
            listItem(paragraph(text("a")), paragraph(text("a2")), {
              type: "orderedList",
              attrs: { order: 3 },
              content: [listItem(paragraph(text("b"))), listItem(paragraph(text("c")))],
            }),
            listItem(paragraph()),
          ],
        },
        { type: "bulletList", content: [listItem(paragraph(text("e")))] },
        { type: "orderedList", content: [listItem(paragraph(text("f")))] },
      ),
    );
  });

  it("writes task lists, with nested ones after their item", () => {
    const result = markdownToAdf("- [x] Done\n  - [ ] Sub\n- [ ] Open");
    const id = expect.any(String);
    expect(result).toEqual(
      doc({
        type: "taskList",
        attrs: { localId: id },
        content: [
          { type: "taskItem", attrs: { localId: id, state: "DONE" }, content: [text("Done")] },
          {
            type: "taskList",
            attrs: { localId: id },
            content: [{ type: "taskItem", attrs: { localId: id, state: "TODO" }, content: [text("Sub")] }],
          },
          { type: "taskItem", attrs: { localId: id, state: "TODO" }, content: [text("Open")] },
        ],
      }),
    );
  });

  it("writes tables with a header row", () => {
    const cell = (type: string, ...content: unknown[]) => ({ type, attrs: {}, content: [paragraph(...content)] });
    expect(markdownToAdf("| A | `b\\|c` |\n| :-- | --- |\n| 1 |\n| 2 | 3 | 4 |")).toEqual(
      doc({
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: [
          { type: "tableRow", content: [cell("tableHeader", text("A")), cell("tableHeader", text("b|c", [code]))] },
          { type: "tableRow", content: [cell("tableCell", text("1")), cell("tableCell")] },
          { type: "tableRow", content: [cell("tableCell", text("2")), cell("tableCell", text("3"))] },
        ],
      }),
    );
  });

  it("writes images back as the media their address names", () => {
    const base = "https://acme.atlassian.net/rest/api/3/attachment/content/10010";
    expect(
      markdownToAdf(
        [
          `![shot.png](${base}#ajour-media?id=f1&collection=&width=800&height=600)`,
          `![](#ajour-media?id=f2&collection=c&layout=wide&size=50)`,
          `![a.pdf](#ajour-media?id=f3&collection=&group=)\n![b.pdf](#ajour-media?id=f4&collection=&group=)`,
          "![Logo](https://img.example/a.png)",
          `See ![](#ajour-media?id=f5&collection=&type=file&inline=) and ![x](https://img.example/b.png)`,
        ].join("\n\n"),
      ),
    ).toEqual(
      doc(
        {
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{ type: "media", attrs: { type: "file", id: "f1", collection: "", alt: "shot.png", width: 800, height: 600 } }],
        },
        {
          type: "mediaSingle",
          attrs: { layout: "wide", width: 50 },
          content: [{ type: "media", attrs: { type: "file", id: "f2", collection: "c" } }],
        },
        {
          type: "mediaGroup",
          content: [
            { type: "media", attrs: { type: "file", id: "f3", collection: "", alt: "a.pdf" } },
            { type: "media", attrs: { type: "file", id: "f4", collection: "", alt: "b.pdf" } },
          ],
        },
        {
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{ type: "media", attrs: { type: "external", url: "https://img.example/a.png", alt: "Logo" } }],
        },
        paragraph(
          text("See "),
          { type: "mediaInline", attrs: { id: "f5", collection: "", type: "file" } },
          text(" and "),
          text("x", [link("https://img.example/b.png")]),
        ),
      ),
    );
  });

  it("keeps raw HTML as text", () => {
    expect(markdownToAdf("<div>a</div>\n\n<b>x</b>")).toEqual(
      doc(paragraph(text("<div>a</div>")), paragraph(text("<b>x</b>"))),
    );
  });
});
