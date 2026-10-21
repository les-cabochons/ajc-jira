import { afterEach, describe, expect, it, vi } from "vitest";
import { readDescription, syncConnection } from "../src/plugin.ts";

const BASE = "https://acme.atlassian.net";
const ISSUE_URL = `${BASE}/browse/ABC-1`;
const SHOT_URL = `${BASE}/rest/api/3/attachment/content/10010`;

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

interface FakeIssue {
  description?: unknown;
  attachment?: Array<{ id: string; filename: string; content: string }>;
  done?: boolean;
}

/** A small Jira: searches return the open issues, or those the JQL names; GET returns one issue. */
function fakeJira(issues: Record<string, FakeIssue>) {
  const requests: Array<{ method: string; path: string; search: string; body?: unknown }> = [];
  const fields = (key: string) => ({
    summary: `Issue ${key}`,
    status: issues[key]!.done
      ? { name: "Done", statusCategory: { key: "done", name: "Done" } }
      : { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
    issuetype: { name: "Task", subtask: false },
    project: { name: "Mercury" },
    description: issues[key]!.description ?? null,
    attachment: issues[key]!.attachment ?? [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path: url.pathname, search: url.search, body });

      if (url.pathname.startsWith("/rest/api/3/search")) {
        const named = /issuekey in \((.*)\)/.exec(body.jql as string)?.[1];
        const keys = named
          ? named.split(",").map((key) => key.trim().replace(/"/g, ""))
          : Object.keys(issues).filter((key) => !issues[key]!.done);
        return json({
          issues: keys.filter((key) => issues[key]).map((key) => ({ id: key, key, fields: fields(key) })),
        });
      }

      const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
      if (issuePath && method === "GET") {
        const key = issuePath[1]!;
        if (!issues[key]) return json({ errorMessages: ["Issue does not exist"] }, 404);
        return json({ id: key, key, fields: fields(key) });
      }

      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    }),
  );
  return { requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("descriptions in a sync", () => {
  it("sends each issue's full description in Markdown beside the old note", async () => {
    fakeJira({
      "ABC-1": {
        description: doc(
          paragraph(text("Ask "), { type: "mention", attrs: { id: "557058:ana", text: "@Ana Silva" } }),
          paragraph(text("Ship it", [{ type: "strong" }])),
        ),
      },
    });

    const result = await syncConnection(connection, []);

    expect(result.items[0]).toMatchObject({
      externalId: "ABC-1",
      note: "Ask [@Ana Silva](mention:557058:ana)\n\n**Ship it**",
      description: { text: "Ask [@Ana Silva](mention:557058:ana)\n\n**Ship it**" },
    });
    expect(result.items[0]!.description).not.toHaveProperty("lost");
    expect(result.items[0]!.description).not.toHaveProperty("cut");
  });

  it("names what the conversion lost", async () => {
    fakeJira({
      "ABC-1": {
        description: doc(
          { type: "panel", attrs: { panelType: "info" }, content: [paragraph(text("Heads up"))] },
          paragraph(text("red", [{ type: "textColor", attrs: { color: "#ff0000" } }]), text(" "), text("u", [{ type: "underline" }])),
          paragraph({ type: "status", attrs: { text: "BLOCKED", color: "red" } }),
        ),
      },
    });

    const result = await syncConnection(connection, []);

    expect(result.items[0]!.description).toEqual({
      text: "> Heads up\n\nred u\n\nBLOCKED",
      lost: ["panels", "text colour", "underline", "status lozenges"],
    });
  });

  it("keeps images as Markdown images whose address is the attachment's, never lost", async () => {
    fakeJira({
      "ABC-1": {
        description: doc({
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{ type: "media", attrs: { type: "file", id: "f1", collection: "", alt: "shot.png" } }],
        }),
        attachment: [{ id: "10010", filename: "shot.png", content: SHOT_URL }],
      },
    });

    const result = await syncConnection(connection, []);

    expect(result.items[0]!.description).toEqual({
      text: `![shot.png](${SHOT_URL}#ajour-media?id=f1&collection=)`,
    });
  });

  it("cuts a description longer than Ajour keeps at 64,000 characters", async () => {
    fakeJira({ "ABC-1": { description: doc(paragraph(text(`${"a".repeat(63_999)}😀 tail`))) } });

    const result = await syncConnection(connection, []);
    const description = result.items[0]!.description!;

    expect(description.cut).toBe(true);
    // The emoji's two code units would straddle the cut, so it goes whole.
    expect(description.text).toBe("a".repeat(63_999));
    expect(result.items[0]!.note).toHaveLength(4000);
  });

  it("sends an empty description for an issue without one", async () => {
    fakeJira({ "ABC-1": {} });

    const result = await syncConnection(connection, []);

    expect(result.items[0]!.description).toEqual({ text: "" });
    expect(result.items[0]!.note).toBeUndefined();
  });

  it("sends the description of a tracked issue that reached Done", async () => {
    fakeJira({ "ABC-2": { done: true, description: doc(paragraph(text("Shipped"))) } });

    const result = await syncConnection(connection, [{ localWorkItemId: "a", sourceId: `${BASE}/browse/ABC-2` }]);

    expect(result.items).toMatchObject([{ externalId: "ABC-2", stateDone: true, description: { text: "Shipped" } }]);
  });

  it("asks the search for the attachments that images point at", async () => {
    const jira = fakeJira({ "ABC-1": {} });

    await syncConnection(connection, []);

    const search = jira.requests.find((request) => request.path.startsWith("/rest/api/3/search"));
    expect((search!.body as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(["description", "attachment"]),
    );
  });

  it("names formatting whose Markdown would not write back as itself", async () => {
    // Two marks that end and start between the same two letters cannot both be Markdown emphasis.
    fakeJira({
      "ABC-1": {
        description: doc(paragraph(text("a"), text("*", [{ type: "em" }]), text("b", [{ type: "strong" }]))),
      },
    });

    const result = await syncConnection(connection, []);

    expect(result.items[0]!.description!.lost).toEqual(["formatting Ajour cannot write back"]);
  });
});

describe("readDescription", () => {
  it("returns the issue's current description, with one GET of its description and attachments", async () => {
    const jira = fakeJira({
      "ABC-1": { description: doc(paragraph(text("Now"), text(" underlined", [{ type: "underline" }]))) },
    });

    await expect(readDescription(connection, { sourceId: ISSUE_URL })).resolves.toEqual({
      description: { text: "Now underlined", lost: ["underline"] },
    });
    expect(jira.requests.map((request) => `${request.method} ${request.path}${request.search}`)).toEqual([
      "GET /rest/api/3/issue/ABC-1?fields=description,attachment",
    ]);
  });

  it("refuses a source id that is not a Jira issue", async () => {
    fakeJira({});

    await expect(readDescription(connection, { sourceId: `${BASE}/projects/ABC` })).rejects.toThrow(
      "is not a Jira issue",
    );
  });
});
