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
    manifest.apiVersion = 1;

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
});
