import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJiraImportCandidates,
  requestJira,
  searchIssues,
  syncJiraConnection,
  validateJiraConnection,
} from "../src/jira.ts";
import { BASE, installAjour, jiraInput, json, noContent, type SeenRequest } from "./support/jira-ajour.ts";

const ESTIMATE_FIELDS = [
  { id: "customfield_10001", name: "Original Estimate", schema: { type: "number" } },
  { id: "customfield_10002", name: "Remaining Work", schema: { type: "number" } },
  { id: "customfield_10003", name: "Completed Work", schema: { type: "number" } },
];

const estimatedIssue = {
  id: "1",
  key: "ENG-1",
  fields: {
    summary: "Investigate incident",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Task", subtask: false },
    priority: { name: "High" },
    project: { name: "Platform" },
    customfield_10001: 12,
    customfield_10002: 8,
    customfield_10003: 4,
  },
};

/** A Jira that answers by endpoint, whatever the order of the requests. */
function jira(answers: { fields?: unknown[]; issues?: unknown[]; account?: unknown }) {
  return installAjour((request: SeenRequest) => {
    if (request.path === "/rest/api/3/myself") return json(answers.account ?? { accountId: "abc123" });
    if (request.path === "/rest/api/3/field") return json(answers.fields ?? []);
    if (request.path.startsWith("/rest/api/3/search")) return json({ issues: answers.issues ?? [] });
    throw new Error(`Unexpected request: ${request.label}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Jira connector validation", () => {
  it("omits empty optional fields from normalized config, and never returns the API token", async () => {
    jira({});

    await expect(
      validateJiraConnection(jiraInput({ baseUrl: "https://example.atlassian.net/", projectKey: undefined })),
    ).resolves.toEqual({
      normalizedConfig: {
        baseUrl: "https://example.atlassian.net",
        email: "me@acme.test",
        queryScope: "assigned_to_me",
      },
      connectionSummary: {
        site: "https://example.atlassian.net",
        projectKey: "All projects",
        scope: "Assigned to me",
      },
    });
  });

  it("asks who the token belongs to with one GET, sending only the headers the manifest lists", async () => {
    const service = jira({});

    await validateJiraConnection(jiraInput());

    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({
      method: "GET",
      path: "/rest/api/3/myself",
      contentType: undefined,
    });
    expect(service.requests[0]).not.toHaveProperty("body");
    // The broker attaches the Basic credential; the plugin never builds one.
    expect(service.requests[0]!.headers).toEqual({ accept: "application/json" });
  });

  it("fails with Jira's own reason when the credential is rejected", async () => {
    installAjour(() => json({ errorMessages: ["Client must be authenticated to access this resource."] }, 401));

    await expect(validateJiraConnection(jiraInput())).rejects.toThrow(
      "Jira request failed (401): Client must be authenticated to access this resource.",
    );
  });

  it("fails when Jira does not name the account", async () => {
    jira({ account: {} });

    await expect(validateJiraConnection(jiraInput())).rejects.toThrow("the current account could not be resolved");
  });

  it("resolves mapped estimate fields", async () => {
    const service = jira({ fields: ESTIMATE_FIELDS });

    await expect(
      validateJiraConnection(
        jiraInput({
          originalEstimateFieldName: "Original Estimate",
          remainingEstimateFieldName: "Remaining Work",
          completedEstimateFieldName: "Completed Work",
        }),
      ),
    ).resolves.toMatchObject({
      normalizedConfig: {
        originalEstimateFieldName: "Original Estimate",
        remainingEstimateFieldName: "Remaining Work",
        completedEstimateFieldName: "Completed Work",
      },
      connectionSummary: {
        originalEstimateFieldName: "Original Estimate",
        remainingEstimateFieldName: "Remaining Work",
        completedEstimateFieldName: "Completed Work",
      },
    });
    expect(service.requests.map((request) => request.label)).toEqual([
      "GET /rest/api/3/myself",
      "GET /rest/api/3/field",
      "GET /rest/api/3/field",
      "GET /rest/api/3/field",
    ]);
  });

  it("reads mapped estimate values from Jira issues", async () => {
    jira({ fields: ESTIMATE_FIELDS, issues: [estimatedIssue] });

    await expect(
      fetchJiraImportCandidates(
        jiraInput({
          originalEstimateFieldName: "Original Estimate",
          remainingEstimateFieldName: "Remaining Work",
          completedEstimateFieldName: "Completed Work",
        }),
      ),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          originalEstimateHours: 12,
          remainingEstimateHours: 8,
          completedEstimateHours: 4,
        }),
      ],
    });
  });

  it("marks a conflict when both local and Jira changed the same mapped field", async () => {
    const service = jira({
      fields: [ESTIMATE_FIELDS[1]],
      issues: [
        {
          id: "1",
          key: "ENG-1",
          fields: {
            summary: "Investigate incident",
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            issuetype: { name: "Task", subtask: false },
            project: { name: "Platform" },
            customfield_10002: 6,
          },
        },
      ],
    });

    await expect(
      syncJiraConnection(jiraInput({ remainingEstimateFieldName: "Remaining Work" }), [
        {
          localWorkItemId: "local-1",
          sourceId: `${BASE}/browse/ENG-1`,
          remainingEstimateHours: 5,
          estimateSync: {
            remainingEstimateHours: {
              baselineValue: 8,
              remoteValue: 8,
            },
          },
        },
      ]),
    ).resolves.toMatchObject({
      workItemUpdates: [
        {
          localWorkItemId: "local-1",
          fields: {
            remainingEstimateHours: expect.objectContaining({
              status: "conflict",
              localValue: 5,
              remoteValue: 6,
              baselineValue: 8,
            }),
          },
        },
      ],
    });
    expect(service.requests.map((request) => request.label)).toEqual([
      "GET /rest/api/3/field",
      "POST /rest/api/3/search/jql",
    ]);
  });

  it("skips mapped estimate sync when a Jira issue type does not expose that field", async () => {
    const service = jira({
      fields: [ESTIMATE_FIELDS[1]],
      issues: [
        {
          id: "1",
          key: "ENG-1",
          fields: {
            summary: "Story without estimate field",
            status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
            issuetype: { name: "Story", subtask: false },
            project: { name: "Platform" },
          },
        },
      ],
    });

    await expect(
      syncJiraConnection(jiraInput({ remainingEstimateFieldName: "Remaining Work" }), [
        {
          localWorkItemId: "local-1",
          sourceId: `${BASE}/browse/ENG-1`,
          remainingEstimateHours: 5,
        },
      ]),
    ).resolves.toMatchObject({
      workItemUpdates: [],
    });
    expect(service.requests).toHaveLength(2);
  });

  it("pushes a changed estimate with a PUT on the issue, as JSON", async () => {
    const service = installAjour((request) => {
      if (request.path === "/rest/api/3/field") return json([ESTIMATE_FIELDS[1]]);
      if (request.path === "/rest/api/3/search/jql") return json({ issues: [estimatedIssue] });
      if (request.method === "PUT") return noContent();
      throw new Error(`Unexpected request: ${request.label}`);
    });

    const result = await syncJiraConnection(jiraInput({ remainingEstimateFieldName: "Remaining Work" }), [
      {
        localWorkItemId: "local-1",
        sourceId: `${BASE}/browse/ENG-1`,
        remainingEstimateHours: 3,
        estimateSync: { remainingEstimateHours: { baselineValue: 8, remoteValue: 8 } },
      },
    ]);

    expect(result.workItemUpdates?.[0]?.fields.remainingEstimateHours).toMatchObject({
      status: "pushed",
      localValue: 3,
    });
    const put = service.requests.find((request) => request.method === "PUT")!;
    expect(put).toMatchObject({
      path: "/rest/api/3/issue/ENG-1",
      contentType: "application/json",
      body: { fields: { customfield_10002: 3 } },
    });
  });

  it("reports a failed estimate push on the field, without failing the sync", async () => {
    installAjour((request) => {
      if (request.path === "/rest/api/3/field") return json([ESTIMATE_FIELDS[1]]);
      if (request.path === "/rest/api/3/search/jql") return json({ issues: [estimatedIssue] });
      if (request.method === "PUT") return json({ errorMessages: ["No permission."] }, 403);
      throw new Error(`Unexpected request: ${request.label}`);
    });

    const result = await syncJiraConnection(jiraInput({ remainingEstimateFieldName: "Remaining Work" }), [
      {
        localWorkItemId: "local-1",
        sourceId: `${BASE}/browse/ENG-1`,
        remainingEstimateHours: 3,
        estimateSync: { remainingEstimateHours: { baselineValue: 8, remoteValue: 8 } },
      },
    ]);

    expect(result.workItemUpdates?.[0]?.fields.remainingEstimateHours).toMatchObject({
      status: "error",
      message: "Jira request failed (403): No permission.",
    });
  });
});

describe("Jira search requests", () => {
  it("posts the JQL as JSON to the search endpoint, with the fields the sync reads", async () => {
    const service = jira({ issues: [] });

    await searchIssues(jiraInput(), "assignee = currentUser()", ["customfield_10002"]);

    expect(service.requests).toHaveLength(1);
    expect(service.requests[0]).toMatchObject({
      method: "POST",
      path: "/rest/api/3/search/jql",
      contentType: "application/json",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: {
        jql: "assignee = currentUser()",
        maxResults: 200,
        fields: expect.arrayContaining(["summary", "description", "attachment", "customfield_10002"]),
      },
    });
  });

  it.each([404, 400])("falls back to the older search endpoint when the new one answers %i", async (status) => {
    const service = installAjour((request) => {
      if (request.path === "/rest/api/3/search/jql") return json({ errorMessages: ["Gone"] }, status);
      if (request.path === "/rest/api/3/search") return json({ issues: [{ id: "1", key: "ENG-1" }] });
      throw new Error(`Unexpected request: ${request.label}`);
    });

    await expect(searchIssues(jiraInput(), "project = ENG")).resolves.toEqual([{ id: "1", key: "ENG-1" }]);
    expect(service.requests.map((request) => [request.method, request.path, request.contentType])).toEqual([
      ["POST", "/rest/api/3/search/jql", "application/json"],
      ["POST", "/rest/api/3/search", "application/json"],
    ]);
  });

  it("does not fall back on other failures", async () => {
    const service = installAjour(() => json({ errorMessages: ["Boom"] }, 500));

    await expect(searchIssues(jiraInput(), "project = ENG")).rejects.toThrow("Jira request failed (500): Boom");
    expect(service.requests).toHaveLength(1);
  });
});

describe("requestJira", () => {
  it("is refused for a method or path the manifest does not declare", async () => {
    installAjour(() => json({}));
    const config = jiraInput();

    await expect(
      requestJira(config, { method: "PUT", path: "/rest/api/3/field", body: {} }),
    ).rejects.toThrow("Jira request failed: The manifest allows no PUT /rest/api/3/field");
    await expect(requestJira(config, { path: "/rest/api/3/project" })).rejects.toThrow(
      "Jira request failed: The manifest allows no GET /rest/api/3/project",
    );
  });

  it("sends a body only with a content type, and a query as a query", async () => {
    const service = installAjour(() => noContent());

    await requestJira(jiraInput(), { path: "/rest/api/3/issue/ENG-1", query: { fields: "status,priority" } });
    await requestJira(jiraInput(), { method: "PUT", path: "/rest/api/3/issue/ENG-1", body: { fields: {} } });

    expect(service.fake.requests.map((request) => [request.method, request.query, request.headers, request.bodyText])).toEqual([
      ["GET", { fields: "status,priority" }, { accept: "application/json" }, undefined],
      ["PUT", undefined, { accept: "application/json", "content-type": "application/json" }, '{"fields":{}}'],
    ]);
  });

  it("passes the abort signal to the request", async () => {
    installAjour(() => json({}));
    const controller = new AbortController();
    controller.abort();

    await expect(requestJira(jiraInput(), { path: "/rest/api/3/myself", signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("names a network failure", async () => {
    installAjour(() => {
      throw Object.assign(new Error("The service could not be reached."), { name: "AjourRequestError", code: "network" });
    });

    await expect(requestJira(jiraInput(), { path: "/rest/api/3/myself" })).rejects.toThrow(
      "Jira request failed: The service could not be reached.",
    );
  });
});
