import { describe, expect, it } from "vitest";
import { adfToMarkdown } from "../src/adf-markdown.ts";

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const listItem = (...content: unknown[]) => ({ type: "listItem", content });

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
            text("bold ", [{ type: "strong" }]),
            text("italic", [{ type: "em" }]),
            text(" "),
            text("gone", [{ type: "strike" }]),
            text(" "),
            text("a `tick`", [{ type: "code" }]),
            text(" "),
            text("spec", [{ type: "link", attrs: { href: "https://example.com/a b" } }]),
          ),
        ),
      ),
    ).toBe("**bold** _italic_ ~~gone~~ `` a `tick` `` [spec](https://example.com/a%20b)");
  });

  it("escapes characters markdown would read as syntax", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(text("# not a heading")),
          paragraph(text("snake_case and *stars* [x]")),
          paragraph(text("1. not a list"), { type: "hardBreak" }, text("- nor this"), { type: "hardBreak" }, text("---")),
          paragraph(text("    not code")),
        ),
      ),
    ).toBe(
      "\\# not a heading\n\nsnake\\_case and \\*stars\\* \\[x\\]\n\n1\\. not a list\n\\- nor this\n\\---\n\nnot code",
    );
  });

  it("renders headings, rules, quotes and panels", () => {
    expect(
      adfToMarkdown(
        doc(
          { type: "heading", attrs: { level: 2 }, content: [text("Context")] },
          { type: "rule" },
          { type: "blockquote", content: [paragraph(text("Quoted")), paragraph(text("Twice"))] },
          { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("Note"))] },
        ),
      ),
    ).toBe("## Context\n\n---\n\n> Quoted\n>\n> Twice\n\n> Note");
  });

  it("renders bullet, ordered and nested lists", () => {
    expect(
      adfToMarkdown(
        doc(
          {
            type: "bulletList",
            content: [
              listItem(paragraph(text("One")), {
                type: "orderedList",
                attrs: { order: 3 },
                content: [listItem(paragraph(text("Three"))), listItem(paragraph(text("Four")))],
              }),
              listItem(paragraph(text("Two"))),
            ],
          },
        ),
      ),
    ).toBe("- One\n  3. Three\n  4. Four\n- Two");
  });

  it("renders task lists", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { state: "DONE" }, content: [text("Done")] },
            { type: "taskItem", attrs: { state: "TODO" }, content: [text("Open")] },
          ],
        }),
      ),
    ).toBe("- [x] Done\n- [ ] Open");
  });

  it("fences code blocks with their language", () => {
    expect(
      adfToMarkdown(
        doc({ type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = `b`;\n```\n")] }),
      ),
    ).toBe("````ts\nconst a = `b`;\n```\n````");
  });

  it("renders tables with the first row as the header", () => {
    const cell = (type: string, value: string) => ({ type, content: [paragraph(text(value))] });
    expect(
      adfToMarkdown(
        doc({
          type: "table",
          content: [
            { type: "tableRow", content: [cell("tableHeader", "Day"), cell("tableHeader", "Hours")] },
            { type: "tableRow", content: [cell("tableCell", "Mon"), cell("tableCell", "7|5")] },
          ],
        }),
      ),
    ).toBe("| Day | Hours |\n| --- | --- |\n| Mon | 7\\|5 |");
  });

  it("renders mentions, emoji, cards, dates and statuses, and leaves attachments out", () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            { type: "mention", attrs: { id: "1", text: "@Sam" } },
            text(" "),
            { type: "emoji", attrs: { shortName: ":smile:", text: "😄" } },
            text(" "),
            { type: "inlineCard", attrs: { url: "https://example.com/card" } },
            text(" "),
            { type: "date", attrs: { timestamp: "1760400000000" } },
            text(" "),
            { type: "status", attrs: { text: "BLOCKED" } },
          ),
          { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x", type: "file" } }] },
        ),
      ),
    ).toBe("@Sam 😄 <https://example.com/card> 2025-10-14 BLOCKED");
  });
});
