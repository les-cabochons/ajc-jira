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

  it("declares API version 3 with no priority scale, since the plugin maps priorities itself", () => {
    expect(validManifest.apiVersion).toBe(3);
    expect(validManifest.capabilities.connector).not.toHaveProperty("priorityScale");
  });
});
