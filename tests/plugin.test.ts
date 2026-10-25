import { afterEach, describe, expect, it, vi } from "vitest";
import * as plugin from "../src/plugin.ts";
import { validateConnection } from "../src/plugin.ts";
import { installAjour, json, pluginConnection } from "./support/jira-ajour.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jira plugin entrypoint", () => {
  it("exports one function per operation the manifest serves, and nothing else", () => {
    expect(Object.keys(plugin).sort()).toEqual([
      "listSettleStates",
      "readDescription",
      "syncConnection",
      "validateConnection",
      "writeDescription",
      "writeSettle",
    ]);
  });
});

describe("jira plugin validateConnection", () => {
  it("preserves task icon display mode in normalized config", async () => {
    const service = installAjour(() => json({ accountId: "abc123" }));

    await expect(
      validateConnection(pluginConnection({ taskIconDisplayMode: "never" }), { capabilities: ["connector"] }),
    ).resolves.toMatchObject({
      normalizedConfig: {
        baseUrl: "https://acme.atlassian.net",
        email: "me@acme.test",
        queryScope: "assigned_to_me",
        taskIconDisplayMode: "never",
      },
    });
    expect(service.requests).toMatchObject([{ method: "GET", path: "/rest/api/3/myself" }]);
  });

  it("sends the request through the connection being validated, which holds no API token", async () => {
    const service = installAjour(() => json({ accountId: "abc123" }));
    const connection = pluginConnection();

    const result = await validateConnection(connection, { capabilities: ["connector"] });

    expect(connection.config).not.toHaveProperty("apiToken");
    expect(result.normalizedConfig).not.toHaveProperty("apiToken");
    expect(service.fake.requests.map((request) => request.connectionId)).toEqual([connection.id]);
  });

  it("rejects non-primitive field values before making a request", async () => {
    const service = installAjour(() => json({}));

    await expect(
      validateConnection(pluginConnection({ projectKey: { invalid: true } as never }), { capabilities: ["connector"] }),
    ).rejects.toThrow("must contain only primitive values");
    expect(service.requests).toHaveLength(0);
  });

  it("requires the site URL and the email, but no token", async () => {
    const service = installAjour(() => json({}));

    await expect(validateConnection(pluginConnection({ baseUrl: " " }), { capabilities: [] })).rejects.toThrow(
      'Jira field "baseUrl" is required.',
    );
    await expect(validateConnection(pluginConnection({ email: "" }), { capabilities: [] })).rejects.toThrow(
      'Jira field "email" is required.',
    );
    expect(service.requests).toHaveLength(0);
  });
});
