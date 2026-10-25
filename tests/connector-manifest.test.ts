import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertConnectorPluginManifest } from "../scripts/connector-manifest.mjs";

const validManifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);

function cloneManifest() {
  return structuredClone(validManifest);
}

describe("connector manifest packaging contract", () => {
  it("accepts the repository manifest", () => {
    expect(assertConnectorPluginManifest(cloneManifest())).toBeTruthy();
  });

  it.each([
    ["displayName", undefined],
    ["iconSvg", undefined],
    ["connectionFields", []],
  ])("rejects an invalid %s", (field, value) => {
    const manifest = cloneManifest();
    manifest[field] = value;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow();
  });

  it("rejects invalid nested connection fields", () => {
    const manifest = cloneManifest();
    manifest.connectionFields[0].defaultValue = { unsafe: true };

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /defaultValue/,
    );
  });

  it("rejects unsupported API versions", () => {
    const manifest = cloneManifest();
    manifest.apiVersion = 2;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /API version/,
    );
  });

  it.each([{}, { codeHost: {} }])("rejects a manifest without the connector capability: %j", (capabilities) => {
    const manifest = cloneManifest();
    manifest.capabilities = capabilities;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(
      /capabilities/,
    );
  });

  it("accepts a connector that also declares codeHost", () => {
    const manifest = cloneManifest();
    manifest.capabilities.codeHost = {};

    expect(assertConnectorPluginManifest(manifest)).toBe(manifest);
  });

  it("declares settle and rejects an invalid one", () => {
    expect(validManifest.capabilities.connector.settle).toBe(true);

    const badSettle = cloneManifest();
    badSettle.capabilities.connector.settle = "yes";
    expect(() => assertConnectorPluginManifest(badSettle)).toThrow(/settle/);
  });

  it("declares description writes with Jira's limit, and rejects an invalid description capability", () => {
    expect(validManifest.capabilities.connector.description).toEqual({ write: true, maxLength: 32767 });

    for (const description of [true, { write: "yes" }, { maxLength: 0 }, { maxLength: 1.5 }, { maxLength: 10_000_001 }]) {
      const manifest = cloneManifest();
      manifest.capabilities.connector.description = description;
      expect(() => assertConnectorPluginManifest(manifest)).toThrow(/description/);
    }
  });

  it("says in the API token's help which permission writing needs", () => {
    const apiToken = validManifest.connectionFields.find((field: { id: string }) => field.id === "apiToken");
    expect(apiToken.helpText).toMatch(/Edit issues/);
  });

  it("declares API version 4 with no priority scale, since the plugin maps priorities itself", () => {
    expect(validManifest.apiVersion).toBe(4);
    expect(validManifest.capabilities.connector).not.toHaveProperty("priorityScale");
  });

  it("rejects an API 3 manifest", () => {
    const manifest = cloneManifest();
    manifest.apiVersion = 3;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/API version must be 4/);
  });

  it("keeps the API token a secret field that is never passed to the plugin", () => {
    const apiToken = validManifest.connectionFields.find((field: { id: string }) => field.id === "apiToken");
    expect(apiToken).toMatchObject({ type: "password", secret: true });
    expect(apiToken).not.toHaveProperty("passToPlugin");
  });
});

describe("network declaration", () => {
  it("lets Ajour's broker attach the Basic credential from the email and the API token", () => {
    expect(validManifest.network.auth).toEqual({ scheme: "basic", userField: "email", secretField: "apiToken" });
    expect(validManifest.network.baseAddress).toEqual({ field: "baseUrl" });
  });

  it("declares exactly the endpoints the plugin calls, relative to the site URL", () => {
    const endpoints = validManifest.network.endpoints.map(
      (endpoint: { method: string; path: string }) => `${endpoint.method} ${endpoint.path}`,
    );
    expect(endpoints).toEqual([
      "GET /rest/api/3/myself",
      "GET /rest/api/3/field",
      "POST /rest/api/3/search/jql",
      "POST /rest/api/3/search",
      "GET /rest/api/3/issue/*",
      "PUT /rest/api/3/issue/*",
      "GET /rest/api/3/issue/*/transitions",
      "POST /rest/api/3/issue/*/transitions",
    ]);
  });

  it("lists only the headers the plugin sets, never the credential's", () => {
    expect(validManifest.network.requestHeaders).toEqual(["Accept", "Content-Type"]);
  });

  it("loads the plugin when needed, and keeps the other defaults", () => {
    expect(validManifest.runtime).toEqual({ start: "whenNeeded" });
    expect(validManifest.connectionAccess).toBeUndefined();
    expect(validManifest.network).not.toHaveProperty("derivedHosts");
  });

  it("requires a network declaration", () => {
    const manifest = cloneManifest();
    delete manifest.network;

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/network/);
  });

  it.each([
    ["a bearer scheme", (manifest: any) => (manifest.network.auth = { scheme: "bearer", secretField: "apiToken" })],
    ["a secret field that is not secret", (manifest: any) => (manifest.network.auth.secretField = "email")],
    ["a user field that does not exist", (manifest: any) => (manifest.network.auth.userField = "nobody")],
    ["a base address that is not a url field", (manifest: any) => (manifest.network.baseAddress.field = "email")],
    ["an absolute endpoint", (manifest: any) => (manifest.network.endpoints[0].path = "https://evil.test/rest/api/3/myself")],
    ["an endpoint with a trailing slash", (manifest: any) => (manifest.network.endpoints[0].path = "/rest/api/3/myself/")],
    ["an unknown method", (manifest: any) => (manifest.network.endpoints[0].method = "TRACE")],
    ["no endpoints", (manifest: any) => (manifest.network.endpoints = [])],
    ["the Authorization header", (manifest: any) => manifest.network.requestHeaders.push("authorization")],
  ])("rejects %s", (_name, change) => {
    const manifest = cloneManifest();
    change(manifest);

    expect(() => assertConnectorPluginManifest(manifest)).toThrow(/network/);
  });
});
