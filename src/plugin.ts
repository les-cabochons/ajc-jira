import type {} from "@ajour/plugin-sdk/globals";
import type { PluginConnection, PluginModule } from "@ajour/plugin-sdk";
import type { ConnectorFieldValues } from "./contract.js";
import { parseConnectorFieldValues } from "./contract.js";
import {
  syncJiraConnection,
  type JiraConnectionInput,
  validateJiraConnection,
} from "./jira.js";
import { listJiraSettleStates, writeJiraSettle } from "./settle.js";
import { readJiraDescription } from "./description-source.js";
import { writeJiraDescription } from "./description-write.js";

/*
 * The plugin's entrypoint, loaded as an ES module in Ajour's sandboxed worker
 * (plugin API 4). Each export is one operation. The connection an operation
 * receives holds no secret: the API token stays with Ajour's broker, which
 * attaches it, with the email, as Basic auth on every `ajour.http` request.
 */

const TASK_ICON_DISPLAY_MODES = new Set(["always", "fallback", "never"]);

function optionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildJiraConfig(connection: PluginConnection): JiraConnectionInput {
  const parsed: ConnectorFieldValues = parseConnectorFieldValues(connection.config);

  if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl.trim()) {
    throw new Error('Jira field "baseUrl" is required.');
  }

  if (typeof parsed.email !== "string" || !parsed.email.trim()) {
    throw new Error('Jira field "email" is required.');
  }

  if (parsed.queryScope !== "assigned_to_me" && parsed.queryScope !== "project_open_issues") {
    throw new Error('Jira field "queryScope" is invalid.');
  }

  return {
    id: connection.id,
    label: connection.label,
    tenantLabel: connection.tenantLabel,
    baseUrl: parsed.baseUrl,
    email: parsed.email,
    projectKey: optionalText(parsed.projectKey),
    queryScope: parsed.queryScope,
    originalEstimateFieldName: optionalText(parsed.originalEstimateFieldName),
    remainingEstimateFieldName: optionalText(parsed.remainingEstimateFieldName),
    completedEstimateFieldName: optionalText(parsed.completedEstimateFieldName),
  };
}

export const validateConnection: NonNullable<PluginModule["validateConnection"]> = async (connection) => {
  const config = parseConnectorFieldValues(connection.config);
  const validation = await validateJiraConnection(buildJiraConfig(connection));
  if (
    typeof config.taskIconDisplayMode !== "string" ||
    !TASK_ICON_DISPLAY_MODES.has(config.taskIconDisplayMode)
  ) {
    return validation;
  }

  return {
    ...validation,
    normalizedConfig: {
      ...validation.normalizedConfig,
      taskIconDisplayMode: config.taskIconDisplayMode,
    },
  };
};

export const syncConnection: NonNullable<PluginModule["syncConnection"]> = async (connection, workItems = []) =>
  await syncJiraConnection(buildJiraConfig(connection), workItems);

/** The issue's current description, read when the user edits it in Ajour. */
export const readDescription: NonNullable<PluginModule["readDescription"]> = async (connection, request) =>
  await readJiraDescription(buildJiraConfig(connection), request);

/** Writes the user's edit, unless the issue's description changed since it was read. */
export const writeDescription: NonNullable<PluginModule["writeDescription"]> = async (connection, request) =>
  await writeJiraDescription(buildJiraConfig(connection), request);

export const listSettleStates: NonNullable<PluginModule["listSettleStates"]> = async (connection, request) =>
  await listJiraSettleStates(buildJiraConfig(connection), request.sourceId);

export const writeSettle: NonNullable<PluginModule["writeSettle"]> = async (connection, request) =>
  await writeJiraSettle(buildJiraConfig(connection), request);
