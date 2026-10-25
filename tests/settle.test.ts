import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorPriorityLevel } from "../src/contract.ts";
import { syncJiraConnection } from "../src/jira.ts";
import { listJiraSettleStates, writeJiraSettle } from "../src/settle.ts";
import { BASE, installAjour, jiraInput, json, noContent } from "./support/jira-ajour.ts";

function sourceId(key: string) {
  return `${BASE}/browse/${key}`;
}

function buildConnection() {
  return jiraInput();
}

const CATEGORIES = {
  new: { key: "new", name: "To Do" },
  indeterminate: { key: "indeterminate", name: "In Progress" },
  done: { key: "done", name: "Done" },
} as const;

function status(name: string, category: keyof typeof CATEGORIES) {
  return { name, statusCategory: CATEGORIES[category] };
}

interface FakeIssue {
  summary: string;
  status: ReturnType<typeof status>;
  priority?: string;
  transitions?: Array<{ id: string; to: ReturnType<typeof status> }>;
}

/**
 * A small Jira: searches return the issues the JQL names, or the open ones;
 * transitions move an issue to their target status; PUT sets the priority.
 */
function fakeJira(issues: Record<string, FakeIssue>) {
  const fields = (key: string) => {
    const issue = issues[key]!;
    return {
      summary: issue.summary,
      status: issue.status,
      priority: issue.priority ? { name: issue.priority } : undefined,
      issuetype: { name: "Task", subtask: false },
      project: { name: "Mercury" },
    };
  };
  return installAjour((request) => {
    const body = request.body;

    if (request.path.startsWith("/rest/api/3/search")) {
      const named = /issuekey in \((.*)\)/.exec(body.jql as string)?.[1];
      const keys = named
        ? named.split(",").map((key) => key.trim().replace(/"/g, ""))
        : Object.keys(issues).filter((key) => issues[key]!.status.statusCategory.key !== "done");
      return json({
        issues: keys.filter((key) => issues[key]).map((key) => ({ id: key, key, fields: fields(key) })),
      });
    }

    const transitionPath = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(request.path);
    if (transitionPath) {
      const issue = issues[transitionPath[1]!]!;
      if (request.method === "POST") {
        const transition = issue.transitions?.find((candidate) => candidate.id === body.transition.id);
        issue.status = transition!.to;
        return noContent();
      }
      return json({ transitions: issue.transitions ?? [] });
    }

    const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(request.path);
    if (issuePath) {
      const key = issuePath[1]!;
      if (request.method === "PUT") {
        issues[key]!.priority = body.fields.priority.name;
        return noContent();
      }
      return json({ id: key, key, fields: fields(key) });
    }

    throw new Error(`Unexpected request: ${request.label}`);
  });
}

describe("Jira status categories in sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports each issue's category and Ajour's issues that reached Done", async () => {
    fakeJira({
      "ABC-1": { summary: "Build the form", status: status("In Progress", "indeterminate") },
      "ABC-2": { summary: "Shipped", status: status("Done", "done") },
      "ABC-3": { summary: "Never imported", status: status("Done", "done") },
    });

    const result = await syncJiraConnection(buildConnection(), [
      { localWorkItemId: "a", sourceId: sourceId("ABC-1") },
      { localWorkItemId: "b", sourceId: sourceId("ABC-2") },
    ]);

    expect(
      result.items.map((item) => [item.externalId, item.state, item.stateCategory, item.stateDone]),
    ).toEqual([
      ["ABC-1", "In Progress", "In Progress", false],
      ["ABC-2", "Done", "Done", true],
    ]);
    expect(result.items[1]?.sourceId).toBe(sourceId("ABC-2"));
  });

  it("sends each issue's priority as an Ajour level, and none for a custom priority", async () => {
    const open = status("To Do", "new");
    fakeJira({
      "ABC-1": { summary: "Outage", status: open, priority: "Highest" },
      "ABC-2": { summary: "Typo", status: open, priority: "Lowest" },
      "ABC-3": { summary: "Odd scheme", status: open, priority: "P2" },
      "ABC-4": { summary: "No priority", status: open },
    });

    const result = await syncJiraConnection(buildConnection(), []);

    expect(
      Object.fromEntries(result.items.map((item) => [item.externalId, item.priority])),
    ).toEqual({
      "ABC-1": "urgent",
      "ABC-2": "low",
      "ABC-3": undefined,
      "ABC-4": undefined,
    });
  });
});

describe("Jira settle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const waiting = status("Waiting for customer", "indeterminate");
  const done = status("Done", "done");
  const toDo = status("To Do", "new");

  function issueInProgress(): FakeIssue {
    return {
      summary: "Fix login",
      status: status("In Progress", "indeterminate"),
      priority: "Medium",
      transitions: [
        { id: "31", to: done },
        { id: "11", to: toDo },
        { id: "21", to: waiting },
      ],
    };
  }

  it("lists the current status and the transitions' targets by category", async () => {
    fakeJira({ "ABC-7": issueInProgress() });

    await expect(listJiraSettleStates(buildConnection(), sourceId("ABC-7"))).resolves.toEqual({
      states: [
        { name: "To Do", category: "To Do", done: false },
        { name: "In Progress", category: "In Progress", done: false },
        { name: "Waiting for customer", category: "In Progress", done: false },
        { name: "Done", category: "Done", done: true },
      ],
    });
  });

  it("writes the priority, then transitions the issue", async () => {
    const jira = fakeJira({ "ABC-7": issueInProgress() });

    const result = await writeJiraSettle(buildConnection(), {
      sourceId: sourceId("ABC-7"),
      state: "done",
      priority: "high",
    });

    expect(
      jira.requests
        .filter((request) => request.method !== "GET")
        .map((request) => [request.method, request.path, request.body]),
    ).toEqual([
      ["PUT", "/rest/api/3/issue/ABC-7", { fields: { priority: { name: "High" } } }],
      ["POST", "/rest/api/3/issue/ABC-7/transitions", { transition: { id: "31" } }],
    ]);
    expect(result).toEqual({
      state: "Done",
      stateCategory: "Done",
      stateDone: true,
      priority: "high",
    });
  });

  it("sends each settle request with its exact method, path, query and content type", async () => {
    const jira = fakeJira({ "ABC-7": issueInProgress() });

    await writeJiraSettle(buildConnection(), { sourceId: sourceId("ABC-7"), state: "done", priority: "high" });

    expect(jira.requests.map((request) => [request.label, request.contentType])).toEqual([
      ["PUT /rest/api/3/issue/ABC-7", "application/json"],
      ["GET /rest/api/3/issue/ABC-7?fields=status,priority", undefined],
      ["GET /rest/api/3/issue/ABC-7/transitions", undefined],
      ["POST /rest/api/3/issue/ABC-7/transitions", "application/json"],
      ["GET /rest/api/3/issue/ABC-7?fields=status,priority", undefined],
    ]);
  });

  it("skips the transition when the issue is already in that status", async () => {
    const jira = fakeJira({ "ABC-7": issueInProgress() });

    await writeJiraSettle(buildConnection(), { sourceId: sourceId("ABC-7"), state: "In Progress" });

    expect(jira.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("refuses a status with no transition, an unknown priority level, and a non-issue", async () => {
    fakeJira({ "ABC-7": issueInProgress() });

    await expect(
      writeJiraSettle(buildConnection(), { sourceId: sourceId("ABC-7"), state: "Blocked" }),
    ).rejects.toThrow('Jira has no transition from "In Progress" to "Blocked" for ABC-7.');
    await expect(
      writeJiraSettle(buildConnection(), {
        sourceId: sourceId("ABC-7"),
        // Ajour validates the level, but the request still crosses a process boundary.
        priority: "critical" as ConnectorPriorityLevel,
      }),
    ).rejects.toThrow('"critical" is not an Ajour priority level.');
    await expect(
      writeJiraSettle(buildConnection(), { sourceId: `${BASE}/projects/ABC`, state: "Done" }),
    ).rejects.toThrow("is not a Jira issue");
  });
});
