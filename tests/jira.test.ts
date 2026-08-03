import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJiraImportCandidates, syncJiraConnection, type JiraConnectionInput, validateJiraConnection } from "../src/jira.ts";

function buildConnection(overrides: Partial<JiraConnectionInput> = {}): JiraConnectionInput {
  return {
    label: "Main connection",
    tenantLabel: "Contoso",
    baseUrl: "https://example.atlassian.net/",
    email: "user@example.com",
    apiToken: "secret",
    queryScope: "assigned_to_me",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("Jira connector validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("omits empty optional fields from normalized config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse({
          accountId: "abc123",
        }),
      ),
    );

    await expect(
      validateJiraConnection(
        buildConnection({
          projectKey: undefined,
        }),
      ),
    ).resolves.toEqual({
      normalizedConfig: {
        baseUrl: "https://example.atlassian.net",
        email: "user@example.com",
        apiToken: "secret",
        queryScope: "assigned_to_me",
      },
      connectionSummary: {
        site: "https://example.atlassian.net",
        projectKey: "All projects",
        scope: "Assigned to me",
      },
    });
  });

  it("resolves mapped estimate fields and reads them from Jira issues", async () => {
    const fieldListResponse = jsonResponse([
      { id: "customfield_10001", name: "Original Estimate", schema: { type: "number" } },
      { id: "customfield_10002", name: "Remaining Work", schema: { type: "number" } },
      { id: "customfield_10003", name: "Completed Work", schema: { type: "number" } },
    ]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            accountId: "abc123",
          }),
        )
        .mockResolvedValueOnce(
          fieldListResponse.clone(),
        )
        .mockResolvedValueOnce(
          fieldListResponse.clone(),
        )
        .mockResolvedValueOnce(
          fieldListResponse.clone(),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issues: [
              {
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
              },
            ],
          }),
        ),
    );

    await expect(
      validateJiraConnection(
        buildConnection({
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
  });

  it("reads mapped estimate values from Jira issues", async () => {
    const fieldListResponse = jsonResponse([
      { id: "customfield_10001", name: "Original Estimate", schema: { type: "number" } },
      { id: "customfield_10002", name: "Remaining Work", schema: { type: "number" } },
      { id: "customfield_10003", name: "Completed Work", schema: { type: "number" } },
    ]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          fieldListResponse.clone(),
        )
        .mockResolvedValueOnce(
          fieldListResponse.clone(),
        )
        .mockResolvedValueOnce(
          fieldListResponse.clone(),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            issues: [
              {
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
              },
            ],
          }),
        ),
    );

    await expect(
      fetchJiraImportCandidates(
        buildConnection({
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
    const fieldListResponse = jsonResponse([
      { id: "customfield_10002", name: "Remaining Work", schema: { type: "number" } },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
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
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncJiraConnection(
        buildConnection({
          remainingEstimateFieldName: "Remaining Work",
        }),
        [
          {
            localWorkItemId: "local-1",
            sourceId: "https://example.atlassian.net/browse/ENG-1",
            remainingEstimateHours: 5,
            estimateSync: {
              remainingEstimateHours: {
                baselineValue: 8,
                remoteValue: 8,
              },
            },
          },
        ],
      ),
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips mapped estimate sync when a Jira issue type does not expose that field", async () => {
    const fieldListResponse = jsonResponse([
      { id: "customfield_10002", name: "Remaining Work", schema: { type: "number" } },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldListResponse.clone())
      .mockResolvedValueOnce(
        jsonResponse({
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
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncJiraConnection(
        buildConnection({
          remainingEstimateFieldName: "Remaining Work",
        }),
        [
          {
            localWorkItemId: "local-1",
            sourceId: "https://example.atlassian.net/browse/ENG-1",
            remainingEstimateHours: 5,
          },
        ],
      ),
    ).resolves.toMatchObject({
      workItemUpdates: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
