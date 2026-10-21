import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDescription } from "../src/plugin.ts";

const BASE = "https://acme.atlassian.net";
const SOURCE_ID = `${BASE}/browse/ABC-7`;
const ISSUE_PATH = "/rest/api/3/issue/ABC-7";

const connection = {
  id: "connection-1",
  pluginId: "jira",
  label: "Main Jira",
  tenantLabel: "Acme",
  autoSync: false,
  autoSyncIntervalMinutes: 15,
  connectedAt: 0,
  config: {
    baseUrl: BASE,
    email: "me@acme.test",
    apiToken: "secret",
    queryScope: "assigned_to_me",
  },
};

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Issue {
  description: unknown;
}

/**
 * Jira holding one issue. A PUT that `refuse` answers for, or made after
 * `changeBeforePut` changed the issue, changes nothing more.
 */
function stubJira(issue: Issue, options: { refuse?: Response; changeBeforePut?: unknown } = {}) {
  const puts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(ISSUE_PATH);
      if (init?.method !== "PUT") {
        return json({ id: "10007", key: "ABC-7", fields: { description: issue.description, attachment: [] } });
      }
      const body = JSON.parse(String(init.body)) as { fields: { description: unknown } };
      puts.push(body);
      if (options.changeBeforePut !== undefined) {
        issue.description = options.changeBeforePut;
      }
      if (options.refuse) return options.refuse;
      issue.description = body.fields.description;
      return new Response(null, { status: 204 });
    }),
  );
  return puts;
}

function writtenDescription(puts: unknown[]) {
  return (puts[0] as { fields: { description: { content: unknown[] } } }).fields.description;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writeDescription", () => {
  it("writes the Markdown as ADF and answers with the description Jira now holds", async () => {
    const issue = { description: doc(paragraph(text("Old "), text("plan", [{ type: "strong" }]))) };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: "New **plan**, ask [@Ana Silva](mention:557058:ana)",
        expected: "Old **plan**",
      }),
    ).resolves.toEqual({
      outcome: "written",
      description: { text: "New **plan**, ask [@Ana Silva](mention:557058:ana)" },
    });
    expect(puts).toEqual([
      {
        fields: {
          description: doc(
            paragraph(
              text("New "),
              text("plan", [{ type: "strong" }]),
              text(", ask "),
              { type: "mention", attrs: { id: "557058:ana", text: "@Ana Silva" } },
            ),
          ),
        },
      },
    ]);
  });

  it("keeps the ADF of the blocks and empty lines the edit leaves alone", async () => {
    const goal = { type: "paragraph", attrs: { localId: "p1" }, content: [text("Goal")] };
    const table = {
      type: "table",
      attrs: { isNumberColumnEnabled: false, layout: "center", width: 760, localId: "t1" },
      content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 1 }, content: [paragraph(text("Day"))] }] }],
    };
    const image = {
      type: "mediaSingle",
      attrs: { layout: "center", localId: "m1" },
      content: [{ type: "media", attrs: { type: "file", id: "f1", collection: "", localId: "x" } }],
    };
    const issue = {
      description: doc(paragraph(), goal, { type: "paragraph" }, paragraph(text("Steps")), table, image, paragraph()),
    };
    const puts = stubJira(issue);
    const before = await import("../src/adf-markdown.ts").then(({ adfToMarkdown }) =>
      adfToMarkdown(issue.description, { issueUrl: SOURCE_ID }),
    );

    await writeDescription(connection, {
      sourceId: SOURCE_ID,
      text: before!.replace("Steps", "New steps"),
      expected: before!,
    });
    expect(writtenDescription(puts)).toEqual(
      doc(paragraph(), goal, { type: "paragraph" }, paragraph(text("New steps")), table, image, paragraph()),
    );
  });

  it("keeps formatting Markdown cannot hold in the blocks the user allowed to lose it in but left alone", async () => {
    const note = paragraph(text("Red note", [{ type: "textColor", attrs: { color: "#ff0000" } }]));
    const issue = { description: doc(paragraph(text("Old plan", [{ type: "underline" }])), note) };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: "New plan\n\nRed note",
        expected: "Old plan\n\nRed note",
        allowedLoss: ["underline", "text colour"],
      }),
    ).resolves.toMatchObject({ outcome: "written", description: { text: "New plan\n\nRed note", lost: ["text colour"] } });
    expect(writtenDescription(puts)).toEqual(doc(paragraph(text("New plan")), note));
  });

  it("keeps every block Markdown cannot hold exactly as it was when the user leaves it alone", async () => {
    const untouched = [
      { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("Heads up"))] },
      { type: "expand", attrs: { title: "More" }, content: [paragraph(text("Body"))] },
      paragraph(text("Due "), { type: "date", attrs: { timestamp: "1760400000000" } }, text(" "), { type: "status", attrs: { text: "OK", color: "green" } }),
      paragraph({ type: "emoji", attrs: { shortName: ":smile:", id: "1f604", text: "😄" } }, text(" trailing ")),
      paragraph(text("bold ", [{ type: "strong" }]), text("x", [{ type: "underline" }]), text("y", [{ type: "textColor", attrs: { color: "#ff0000" } }])),
      { type: "codeBlock", attrs: { language: "js", wrap: true }, content: [text("x")] },
      {
        type: "table",
        attrs: { layout: "wide" },
        content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colwidth: [90], background: "#eeeeee" }, content: [paragraph(text(" a "), { type: "hardBreak" }, text("b"))] }] }],
      },
      { type: "blockquote", content: [paragraph(text("a")), paragraph(), paragraph(text("b"))] },
      { type: "blockCard", attrs: { url: "https://e.com" } },
      { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "file", id: "f", collection: "" } }, { type: "caption", content: [text("Cap")] }] },
    ];
    const issue = { description: doc(paragraph(text("Old plan")), ...untouched) };
    const puts = stubJira(issue);
    const { describeJiraDescription } = await import("../src/description.ts");
    const current = describeJiraDescription(issue.description, { issueUrl: SOURCE_ID });

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: current.text.replace("Old plan", "New plan"),
        expected: current.text,
        allowedLoss: current.lost,
      }),
    ).resolves.toMatchObject({ outcome: "written" });
    expect(writtenDescription(puts)).toEqual(doc(paragraph(text("New plan")), ...untouched));
  });

  it("keeps the empty lines around blocks when a new one goes between them", async () => {
    const issue = { description: doc(paragraph(text("a")), paragraph(), paragraph(), paragraph(text("b"))) };
    const puts = stubJira(issue);

    await writeDescription(connection, { sourceId: SOURCE_ID, text: "a\n\nnew\n\nb", expected: "a\n\nb" });
    expect(writtenDescription(puts)).toEqual(
      doc(paragraph(text("a")), paragraph(), paragraph(), paragraph(text("new")), paragraph(text("b"))),
    );
  });

  it("keeps a table's code with a pipe exactly when another cell changes", async () => {
    const header = (content: unknown[]) => ({ type: "tableHeader", content: [paragraph(...content)] });
    const issue = {
      description: doc({
        type: "table",
        content: [{ type: "tableRow", content: [header([text("a|b", [{ type: "code" }])]), header([text("x")])] }],
      }),
    };
    const puts = stubJira(issue);

    await writeDescription(connection, { sourceId: SOURCE_ID, text: "| `a\\|b` | y |\n| --- | --- |", expected: "| `a\\|b` | x |\n| --- | --- |" });
    const table = (writtenDescription(puts) as { content: Array<{ content: Array<{ content: Array<{ content: unknown[] }> }> }> }).content[0]!;
    expect(table.content[0]!.content[0]!.content).toEqual([paragraph(text("a|b", [{ type: "code" }]))]);
  });

  it("writes nothing over a table whose code holds a backslash before a pipe, which Markdown tables cannot keep", async () => {
    const header = (content: unknown[]) => ({ type: "tableHeader", content: [paragraph(...content)] });
    const issue = {
      description: doc({
        type: "table",
        content: [{ type: "tableRow", content: [header([text("a\\|b", [{ type: "code" }])]), header([text("x")])] }],
      }),
    };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "| `a\\|b` | y |\n| --- | --- |", expected: "| `a\\|b` | x |\n| --- | --- |" }),
    ).rejects.toThrow("Writing it would lose its other formatting in Jira. Edit it there.");
    expect(puts).toEqual([]);
  });

  it("writes nothing when the description loses more kinds of formatting than Ajour can name", async () => {
    const mark = (type: string, attrs?: Record<string, unknown>) => ({ type, ...(attrs ? { attrs } : {}) });
    const lossy = [
      paragraph(text("a", [mark("textColor", { color: "#ff0000" })])),
      paragraph(text("a", [mark("backgroundColor", { color: "#ffff00" })])),
      paragraph(text("a", [mark("underline")])),
      paragraph(text("a", [mark("subsup", { type: "sup" })])),
      paragraph(text("a", [mark("subsup", { type: "sub" })])),
      paragraph(text("a", [mark("annotation", { id: "x", annotationType: "inlineComment" })])),
      { ...paragraph(text("a")), marks: [mark("alignment", { align: "center" })] },
      { ...paragraph(text("a")), marks: [mark("indentation", { level: 1 })] },
      { ...paragraph(text("a")), marks: [mark("fontSize", { fontSize: "small" })] },
      { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("a"))] },
      { type: "expand", attrs: { title: "T" }, content: [paragraph(text("a"))] },
      paragraph({ type: "status", attrs: { text: "OK", color: "green" } }),
      paragraph({ type: "date", attrs: { timestamp: "0" } }),
      paragraph({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }),
      { type: "blockCard", attrs: { url: "https://e.com" } },
      { type: "codeBlock", marks: [mark("breakout", { mode: "wide" })], content: [text("x")] },
      { type: "bodiedExtension", attrs: {}, content: [paragraph(text("a"))] },
      paragraph(text("a ")),
      paragraph(text("a", [mark("code"), mark("strong")])),
      { type: "heading", attrs: { level: 1 }, content: [text("a"), { type: "hardBreak" }, text("b")] },
      // The 21st: a caption a colleague added, which Ajour could never show the user.
      { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "file", id: "f", collection: "" } }, { type: "caption", content: [text("Cap")] }] },
    ];
    const issue = { description: doc(paragraph(text("Old plan")), ...lossy) };
    const puts = stubJira(issue);
    const { describeJiraDescription } = await import("../src/description.ts");
    const shown = describeJiraDescription(issue.description, { issueUrl: SOURCE_ID });
    expect(shown.lost).toHaveLength(20);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: shown.text.replace("Old plan", "New plan"),
        expected: shown.text,
        allowedLoss: shown.lost,
      }),
    ).rejects.toThrow("loses more kinds of formatting than Ajour can name");
    expect(puts).toEqual([]);
  });

  it("keeps a block the user moved as it was", async () => {
    const tasks = {
      type: "taskList",
      attrs: { localId: "l1" },
      content: [{ type: "taskItem", attrs: { localId: "t1", state: "TODO" }, content: [text("Ship")] }],
    };
    const note = { type: "paragraph", attrs: { localId: "n1" }, content: [text("Note")] };
    const issue = { description: doc(tasks, note) };
    const puts = stubJira(issue);

    await writeDescription(connection, { sourceId: SOURCE_ID, text: "Note\n\n- [ ] Ship", expected: "- [ ] Ship\n\nNote" });
    expect(writtenDescription(puts)).toEqual(doc(note, tasks));
  });

  it("writes nothing when it cannot tell which of two blocks that read the same the user kept", async () => {
    const red = paragraph(text("Note", [{ type: "textColor", attrs: { color: "#ff0000" } }]));
    const issue = { description: doc(red, paragraph(text("Note"))) };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: "Note",
        expected: "Note\n\nNote",
        allowedLoss: ["text colour"],
      }),
    ).rejects.toThrow("cannot tell which you kept");
    expect(puts).toEqual([]);
  });

  it("keeps the empty lines of a description that had nothing else", async () => {
    const issue = { description: doc(paragraph(), { type: "paragraph", content: [{ type: "hardBreak" }] }) };
    const puts = stubJira(issue);

    await writeDescription(connection, { sourceId: SOURCE_ID, text: "Plan", expected: "" });
    expect(writtenDescription(puts)).toEqual(
      doc(paragraph(text("Plan")), paragraph(), { type: "paragraph", content: [{ type: "hardBreak" }] }),
    );
  });

  it("passes on the reason Jira gives for a field it refuses", async () => {
    const issue = { description: doc(paragraph(text("Old plan"))) };
    stubJira(issue, {
      refuse: json({ errorMessages: [], errors: { description: "Operation value must be an Atlassian Document." } }, 400),
    });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("Jira request failed (400): description: Operation value must be an Atlassian Document.");
  });

  it("writes nothing over a loss the user did not see", async () => {
    // The user saw the underline; a colleague then added colour to the same text.
    const issue = {
      description: doc(
        paragraph(text("Old plan", [{ type: "underline" }, { type: "textColor", attrs: { color: "#ff0000" } }])),
      ),
    };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: "New plan",
        expected: "Old plan",
        allowedLoss: ["underline"],
      }),
    ).rejects.toThrow("Writing it would lose its text colour in Jira. Edit it there.");
    expect(puts).toEqual([]);
  });

  it("writes nothing over formatting a colleague added to the same text", async () => {
    const issue = { description: doc(paragraph(text("Old plan", [{ type: "underline" }]))) };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("Writing it would lose its underline in Jira. Edit it there.");
    expect(puts).toEqual([]);
  });

  it("writes nothing over a description changed since Ajour read it", async () => {
    const issue = { description: doc(paragraph(text("Changed by a colleague"))) };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).resolves.toEqual({ outcome: "conflict", description: { text: "Changed by a colleague" } });
    expect(puts).toEqual([]);
  });

  it("answers a conflict when Jira refuses the edit as a conflicting update and the description moved", async () => {
    const issue = { description: doc(paragraph(text("Old plan"))) };
    stubJira(issue, {
      changeBeforePut: doc(paragraph(text("Changed meanwhile"))),
      refuse: json({ errorMessages: ["The issue was updated by someone else."] }, 409),
    });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).resolves.toEqual({ outcome: "conflict", description: { text: "Changed meanwhile" } });
  });

  it("passes on a refused edit that is not a conflict", async () => {
    const issue = { description: doc(paragraph(text("Old plan"))) };
    stubJira(issue, {
      refuse: json({ errorMessages: ["You do not have permission to edit issues in this project."] }, 400),
    });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("Jira request failed (400): You do not have permission to edit issues in this project.");
  });

  it("passes on a conflicting update that left the description as Ajour expects", async () => {
    const issue = { description: doc(paragraph(text("Old plan"))) };
    stubJira(issue, { refuse: json({ errorMessages: ["Conflicting update."] }, 409) });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("Jira request failed (409): Conflicting update.");
  });

  it("refuses a description too long for Jira once converted, writing nothing", async () => {
    const issue = { description: doc(paragraph(text("Old plan"))) };
    const puts = stubJira(issue);
    const long = Array.from({ length: 1_500 }, (_, index) => `**${index}**`).join("\n\n");

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: long, expected: "Old plan" }),
    ).rejects.toThrow(/too long for Jira: [\d,]+ of 32,767 characters once converted/);
    expect(puts).toEqual([]);
  });

  it("answers a conflict, cut as it is, when the description grew past what Ajour keeps", async () => {
    const issue = { description: doc(paragraph(text("word ".repeat(13_000)))) };
    const puts = stubJira(issue);

    const result = await writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" });

    expect(result.outcome).toBe("conflict");
    expect(result.description.cut).toBe(true);
    expect(puts).toEqual([]);
  });

  it("clears the description when the text is empty", async () => {
    const issue = { description: doc(paragraph(text("Old plan"))) };
    const puts = stubJira(issue);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "", expected: "Old plan" }),
    ).resolves.toEqual({ outcome: "written", description: { text: "" } });
    expect(puts).toEqual([{ fields: { description: null } }]);
  });

  it("writes a whole new description on an issue that had none", async () => {
    const issue = { description: null };
    const puts = stubJira(issue);

    await writeDescription(connection, { sourceId: SOURCE_ID, text: "# Plan\n\n- [ ] Ship", expected: "" });
    expect(writtenDescription(puts)).toEqual(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
        {
          type: "taskList",
          attrs: { localId: expect.any(String) },
          content: [{ type: "taskItem", attrs: { localId: expect.any(String), state: "TODO" }, content: [text("Ship")] }],
        },
      ),
    );
  });

  it("joins a kept block to the edit when Markdown reads them as one", async () => {
    const first = { type: "bulletList", attrs: { localId: "l1" }, content: [{ type: "listItem", content: [paragraph(text("a"))] }] };
    const issue = { description: doc(first, paragraph(text("b"))) };
    const puts = stubJira(issue);

    // The new line right under the list continues its item.
    await writeDescription(connection, { sourceId: SOURCE_ID, text: "- a\n  more\n\nb", expected: "- a\n\nb" });
    const written = writtenDescription(puts) as { content: unknown[] };
    expect(written.content[0]).toEqual({
      type: "bulletList",
      content: [{ type: "listItem", content: [paragraph(text("a"), { type: "hardBreak" }, text("more"))] }],
    });
    expect(written.content[1]).toEqual(paragraph(text("b")));
  });

  it("refuses a source id that is not a Jira issue", async () => {
    stubJira({ description: null });

    await expect(
      writeDescription(connection, { sourceId: `${BASE}/projects/ABC`, text: "x", expected: "" }),
    ).rejects.toThrow("is not a Jira issue");
  });
});
