import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleOptions } from "../scripts/bundle-options.mjs";
import manifest from "../plugin.json";

/*
 * The built bundle, loaded the way Ajour's worker loads a plugin: as an ES
 * module imported by URL, whose named exports are the operations, running
 * with a frozen `ajour` global and nothing else. The global here is a small
 * stand-in for the broker: it builds the URL from the saved site address,
 * attaches the Basic credential the connection's fields hold, refuses what
 * the manifest does not declare, and forwards to a fixture Jira.
 */

const BASE = "https://acme.atlassian.net";
const EMAIL = "me@acme.test";
const TOKEN = "atlassian-token-5c0ffee";
const BASIC = `Basic ${btoa(`${EMAIL}:${TOKEN}`)}`;
const CONNECTION_ID = "connection-1";

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });

interface Received {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body?: any;
}

interface FixtureIssue {
  summary: string;
  status: { name: string; statusCategory: { key: string; name: string } };
  priority?: string;
  description?: unknown;
  transitions?: { id: string; to: FixtureIssue["status"] }[];
  remaining?: number;
}

const TODO = { name: "To Do", statusCategory: { key: "new", name: "To Do" } };
const DONE = { name: "Done", statusCategory: { key: "done", name: "Done" } };

let received: Received[] = [];
let issues: Record<string, FixtureIssue> = {};
let moduleExports: Record<string, (...args: any[]) => Promise<any>>;
let bundleText = "";
let workDir = "";

function issueJson(key: string) {
  const issue = issues[key]!;
  return {
    id: key,
    key,
    fields: {
      summary: issue.summary,
      status: issue.status,
      priority: issue.priority ? { name: issue.priority } : undefined,
      issuetype: { name: "Task", subtask: false },
      project: { name: "Mercury" },
      description: issue.description ?? null,
      attachment: [],
      customfield_10002: issue.remaining,
    },
  };
}

/** A fixture Jira. It refuses any request that does not carry the Basic credential. */
function jira(request: Received): { status: number; body?: unknown } {
  if (request.headers.authorization !== BASIC) {
    return { status: 401, body: { errorMessages: ["Client must be authenticated to access this resource."] } };
  }
  if (request.path === "/rest/api/3/myself") return { status: 200, body: { accountId: "abc123" } };
  if (request.path === "/rest/api/3/field") {
    return { status: 200, body: [{ id: "customfield_10002", name: "Remaining Work", schema: { type: "number" } }] };
  }
  if (request.path === "/rest/api/3/search/jql") {
    const named = /issuekey in \((.*)\)/.exec(request.body.jql as string)?.[1];
    const keys = named
      ? named.split(",").map((key) => key.trim().replaceAll('"', ""))
      : Object.keys(issues).filter((key) => issues[key]!.status.statusCategory.key !== "done");
    return { status: 200, body: { issues: keys.filter((key) => issues[key]).map(issueJson) } };
  }

  const transitions = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(request.path);
  if (transitions) {
    const issue = issues[transitions[1]!]!;
    if (request.method === "POST") {
      issue.status = issue.transitions!.find((candidate) => candidate.id === request.body.transition.id)!.to;
      return { status: 204 };
    }
    return { status: 200, body: { transitions: issue.transitions ?? [] } };
  }

  const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(request.path);
  if (issuePath) {
    const key = issuePath[1]!;
    if (request.method === "PUT") {
      const fields = request.body.fields;
      if (fields.priority) issues[key]!.priority = fields.priority.name;
      if ("description" in fields) issues[key]!.description = fields.description;
      if ("customfield_10002" in fields) issues[key]!.remaining = fields.customfield_10002;
      return { status: 204 };
    }
    return { status: 200, body: issueJson(key) };
  }
  return { status: 404, body: { errorMessages: ["No such endpoint"] } };
}

function endpointMatches(pattern: string, requestPath: string) {
  const patternParts = pattern.split("/");
  const parts = requestPath.split("/");
  return patternParts.length === parts.length && patternParts.every((part, index) => part === "*" || part === parts[index]);
}

/** What Ajour's broker does for `ajour.http`, in miniature. */
function installAjour() {
  const allowedHeaders = new Set(manifest.network.requestHeaders.map((header) => header.toLowerCase()));
  const http = async (request: {
    connectionId: string;
    method: string;
    path: string;
    query?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    body?: string;
  }) => {
    if (request.connectionId !== CONNECTION_ID) throw Object.assign(new Error("No such connection."), { code: "refused" });
    if (!manifest.network.endpoints.some((endpoint) => endpoint.method === request.method && endpointMatches(endpoint.path, request.path))) {
      throw Object.assign(new Error(`The manifest allows no ${request.method} ${request.path}.`), {
        name: "AjourRequestError",
        code: "refused",
      });
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!allowedHeaders.has(name.toLowerCase())) {
        throw Object.assign(new Error(`The manifest does not list the ${name} header.`), { code: "refused" });
      }
      headers[name.toLowerCase()] = value;
    }
    const url = new URL(BASE + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.append(key, String(value));
    const seen: Received = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      headers: { ...headers, authorization: BASIC },
      ...(request.body !== undefined ? { body: JSON.parse(request.body) } : {}),
    };
    received.push(seen);
    const answer = jira(seen);
    const payload = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return Object.freeze({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: Object.freeze({}),
      text: async () => payload,
      json: async () => JSON.parse(payload),
    });
  };
  Object.defineProperty(globalThis, "ajour", {
    value: Object.freeze({
      http,
      publicFetch: async () => {
        throw new Error("The plugin has no public hosts.");
      },
      log: () => undefined,
    }),
    configurable: true,
    enumerable: true,
  });
}

/** The connection as Ajour hands it to an API 4 operation: no secret field. */
function connection(config: Record<string, string | number | boolean> = {}) {
  return {
    id: CONNECTION_ID,
    pluginId: "jira",
    label: "Main Jira",
    tenantLabel: "Acme",
    autoSync: false,
    autoSyncIntervalMinutes: 15,
    connectedAt: 1,
    access: [],
    config: { baseUrl: BASE, email: EMAIL, queryScope: "assigned_to_me", ...config },
  };
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "ajc-jira-bundle-"));
  const outfile = path.join(workDir, "plugin.mjs");
  await build({ ...bundleOptions, entryPoints: [path.resolve("src/plugin.ts")], outfile, logLevel: "silent" });
  bundleText = await readFile(outfile, "utf8");
  // Installed before the import, as the worker defines `ajour` before it imports the plugin.
  installAjour();
  moduleExports = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
});

afterAll(async () => {
  Reflect.deleteProperty(globalThis, "ajour");
  await rm(workDir, { recursive: true, force: true });
});

describe("the built bundle", () => {
  it("is a browser ES module: no Node built-in, Buffer, process, require or global fetch", () => {
    expect(bundleText).not.toMatch(/\brequire\s*\(/);
    expect(bundleText).not.toMatch(/\bfrom\s*["']node:/);
    expect(bundleText).not.toMatch(/\bimport\s*\(?\s*["']node:/);
    expect(bundleText).not.toMatch(/\bBuffer\b/);
    expect(bundleText).not.toMatch(/\bprocess\s*\./);
    expect(bundleText).not.toMatch(/\bfetch\s*\(/);
    expect(bundleText).not.toMatch(/\bXMLHttpRequest\b|\bWebSocket\b/);
    expect(bundleText).not.toMatch(/\bAuthorization\b/i);
    expect(bundleText).not.toContain("apiToken");
  });

  it("exports one function per operation the worker may call", () => {
    expect(Object.keys(moduleExports).sort()).toEqual([
      "listSettleStates",
      "readDescription",
      "syncConnection",
      "validateConnection",
      "writeDescription",
      "writeSettle",
    ]);
    for (const operation of Object.values(moduleExports)) expect(typeof operation).toBe("function");
  });
});

describe("the built bundle, run through a stand-in broker", () => {
  const sourceId = (key: string) => `${BASE}/browse/${key}`;

  function reset() {
    received = [];
    issues = {
      "ABC-1": {
        summary: "Build the form",
        status: TODO,
        priority: "Medium",
        description: doc(paragraph(text("Ask "), { type: "mention", attrs: { id: "557058:ana", text: "@Ana Silva" } })),
        remaining: 8,
        transitions: [{ id: "31", to: DONE }],
      },
      "ABC-2": { summary: "Shipped", status: DONE },
    };
  }

  beforeAll(reset);

  it("validates the connection with one GET, and returns no secret", async () => {
    reset();

    const result = await moduleExports.validateConnection!(connection({ taskIconDisplayMode: "never" }), { capabilities: ["connector"] });

    expect(result).toEqual({
      normalizedConfig: { baseUrl: BASE, email: EMAIL, queryScope: "assigned_to_me", taskIconDisplayMode: "never" },
      connectionSummary: { site: BASE, projectKey: "All projects", scope: "Assigned to me" },
    });
    expect(received.map((request) => `${request.method} ${request.path}${request.search}`)).toEqual(["GET /rest/api/3/myself"]);
  });

  it("syncs open issues, finds the ones that reached Done, and keeps the description in Markdown", async () => {
    reset();

    const result = await moduleExports.syncConnection!(connection({ remainingEstimateFieldName: "Remaining Work" }), [
      { localWorkItemId: "a", sourceId: sourceId("ABC-1"), remainingEstimateHours: 8, estimateSync: { remainingEstimateHours: { baselineValue: 8, remoteValue: 8 } } },
      { localWorkItemId: "b", sourceId: sourceId("ABC-2") },
    ]);

    expect(result.items.map((item: any) => [item.externalId, item.state, item.stateDone, item.connectionId])).toEqual([
      ["ABC-1", "To Do", false, CONNECTION_ID],
      ["ABC-2", "Done", true, CONNECTION_ID],
    ]);
    expect(result.items[0]).toMatchObject({
      sourceId: sourceId("ABC-1"),
      priority: "medium",
      remainingEstimateHours: 8,
      description: { text: "Ask [@Ana Silva](mention:557058:ana)" },
    });
    expect(received.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /rest/api/3/field",
      "POST /rest/api/3/search/jql",
      "POST /rest/api/3/search/jql",
    ]);
    expect(received.every((request) => request.headers.authorization === BASIC)).toBe(true);
    expect(received[1]!.headers["content-type"]).toBe("application/json");
  });

  it("pushes a local estimate with a PUT", async () => {
    reset();

    const result = await moduleExports.syncConnection!(connection({ remainingEstimateFieldName: "Remaining Work" }), [
      { localWorkItemId: "a", sourceId: sourceId("ABC-1"), remainingEstimateHours: 3, estimateSync: { remainingEstimateHours: { baselineValue: 8, remoteValue: 8 } } },
    ]);

    expect(result.workItemUpdates[0].fields.remainingEstimateHours).toMatchObject({ status: "pushed" });
    expect(issues["ABC-1"]!.remaining).toBe(3);
    expect(received.find((request) => request.method === "PUT")).toMatchObject({
      path: "/rest/api/3/issue/ABC-1",
      body: { fields: { customfield_10002: 3 } },
    });
  });

  it("lists the settle states and settles with a priority write, then a transition", async () => {
    reset();

    await expect(moduleExports.listSettleStates!(connection(), { sourceId: sourceId("ABC-1") })).resolves.toEqual({
      states: [
        { name: "To Do", category: "To Do", done: false },
        { name: "Done", category: "Done", done: true },
      ],
    });

    await expect(
      moduleExports.writeSettle!(connection(), { sourceId: sourceId("ABC-1"), state: "Done", priority: "high" }),
    ).resolves.toEqual({ state: "Done", stateCategory: "Done", stateDone: true, priority: "high" });
    expect(issues["ABC-1"]).toMatchObject({ priority: "High", status: DONE });
  });

  it("reads and writes a description, and answers a conflict when it moved", async () => {
    reset();

    await expect(moduleExports.readDescription!(connection(), { sourceId: sourceId("ABC-1") })).resolves.toEqual({
      description: { text: "Ask [@Ana Silva](mention:557058:ana)" },
    });

    await expect(
      moduleExports.writeDescription!(connection(), {
        sourceId: sourceId("ABC-1"),
        text: "Ask [@Ana Silva](mention:557058:ana) soon",
        expected: "Ask [@Ana Silva](mention:557058:ana)",
      }),
    ).resolves.toEqual({
      outcome: "written",
      description: { text: "Ask [@Ana Silva](mention:557058:ana) soon" },
    });

    await expect(
      moduleExports.writeDescription!(connection(), {
        sourceId: sourceId("ABC-1"),
        text: "Overwrite",
        expected: "Ask [@Ana Silva](mention:557058:ana)",
      }),
    ).resolves.toMatchObject({ outcome: "conflict", description: { text: "Ask [@Ana Silva](mention:557058:ana) soon" } });
    const writes = received.filter((request) => request.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: "/rest/api/3/issue/ABC-1" });
    expect(writes[0]!.headers["content-type"]).toBe("application/json");
  });

  it("fails an operation with Jira's reason when the broker's credential is rejected", async () => {
    reset();
    const rejected = { ...connection(), id: CONNECTION_ID };
    const original = (globalThis as any).ajour;
    Object.defineProperty(globalThis, "ajour", {
      value: Object.freeze({
        ...original,
        http: async () => ({
          status: 401,
          ok: false,
          headers: {},
          text: async () => JSON.stringify({ errorMessages: ["Unauthorized"] }),
          json: async () => ({}),
        }),
      }),
      configurable: true,
    });

    try {
      await expect(moduleExports.validateConnection!(rejected, { capabilities: [] })).rejects.toThrow(
        "Jira request failed (401): Unauthorized",
      );
    } finally {
      Object.defineProperty(globalThis, "ajour", { value: original, configurable: true, enumerable: true });
    }
  });
});
