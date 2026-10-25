import { vi } from "vitest";
import type { PluginConnection, PluginManifest } from "@ajour/plugin-sdk";
import { createFakeAjour, type FakeAjour, type FakeResponseInit, type RecordedHttpRequest } from "@ajour/plugin-sdk/testing";
import manifestJson from "../../plugin.json";
import type { JiraConnectionInput } from "../../src/jira.ts";

/** The repository's own manifest: the fake refuses any request it does not declare, as Ajour's broker does. */
export const manifest = manifestJson as unknown as PluginManifest;

export const BASE = "https://acme.atlassian.net";
export const CONNECTION_ID = "connection-1";

/** The connection an API 4 operation receives: no API token, which stays with Ajour's broker. */
export function pluginConnection(config: Record<string, string | number | boolean> = {}): PluginConnection {
  return {
    id: CONNECTION_ID,
    pluginId: "jira",
    label: "Main Jira",
    tenantLabel: "Acme",
    autoSync: false,
    autoSyncIntervalMinutes: 15,
    connectedAt: 0,
    access: [],
    config: {
      baseUrl: BASE,
      email: "me@acme.test",
      queryScope: "assigned_to_me",
      ...config,
    },
  };
}

export function jiraInput(overrides: Partial<JiraConnectionInput> = {}): JiraConnectionInput {
  return {
    id: CONNECTION_ID,
    label: "Main Jira",
    tenantLabel: "Acme",
    baseUrl: BASE,
    email: "me@acme.test",
    queryScope: "assigned_to_me",
    ...overrides,
  };
}

/** A request as a test reads it: the JSON body parsed, the query as a string. */
export interface SeenRequest {
  method: string;
  path: string;
  /** `?a=b&c=d`, or an empty string. */
  search: string;
  query: RecordedHttpRequest["query"];
  headers: Record<string, string>;
  contentType: string | undefined;
  body?: any;
  /** `GET /rest/api/3/issue/ABC-1?fields=status`, for assertions on a request list. */
  label: string;
}

export function json(body: unknown, status = 200): FakeResponseInit {
  return { status, json: body };
}

export function noContent(): FakeResponseInit {
  return { status: 204 };
}

function seen(request: RecordedHttpRequest): SeenRequest {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(request.query ?? {})) {
    for (const value of Array.isArray(raw) ? raw : [raw]) params.append(key, String(value));
  }
  const search = params.size > 0 ? `?${params.toString().replaceAll("%2C", ",")}` : "";
  return {
    method: request.method,
    path: request.path,
    search,
    query: request.query,
    headers: request.headers,
    contentType: request.headers["content-type"],
    ...(request.bodyText !== undefined ? { body: JSON.parse(request.bodyText) } : {}),
    label: `${request.method} ${request.path}${search}`,
  };
}

/**
 * Installs an `ajour` global that answers every endpoint the manifest declares
 * with `respond`, and refuses the rest. `requests` lists what the plugin sent.
 */
export function installAjour(respond: (request: SeenRequest) => FakeResponseInit | Promise<FakeResponseInit>) {
  const requests: SeenRequest[] = [];
  const fake: FakeAjour = createFakeAjour({
    manifest,
    routes: (manifest.network?.endpoints ?? []).map((endpoint) => ({
      method: endpoint.method,
      path: endpoint.path,
      respond: (recorded: RecordedHttpRequest) => {
        const request = seen(recorded);
        requests.push(request);
        return respond(request);
      },
    })),
  });
  vi.stubGlobal("ajour", fake);
  return { requests, fake };
}
