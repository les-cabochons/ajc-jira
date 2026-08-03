import type {
  ConnectorFieldValues,
  ConnectorPluginConnection,
  ConnectorSyncWorkItem,
} from "./contract.js";
import { parseConnectorFieldValues } from "./contract.js";
import {
  syncJiraConnection,
  type JiraConnectionInput,
  validateJiraConnection,
} from "./jira.js";

const TASK_ICON_DISPLAY_MODES = new Set(["always", "fallback", "never"]);

function buildJiraConfig(values: ConnectorFieldValues, connection?: { id: string; label: string; tenantLabel: string }): JiraConnectionInput {
  const parsed = parseConnectorFieldValues(values);

  if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl.trim()) {
    throw new Error('Jira field "baseUrl" is required.');
  }

  if (typeof parsed.email !== "string" || !parsed.email.trim()) {
    throw new Error('Jira field "email" is required.');
  }

  if (typeof parsed.apiToken !== "string" || !parsed.apiToken.trim()) {
    throw new Error('Jira field "apiToken" is required.');
  }

  if (parsed.queryScope !== "assigned_to_me" && parsed.queryScope !== "project_open_issues") {
    throw new Error('Jira field "queryScope" is invalid.');
  }

  return {
    id: connection?.id,
    label: connection?.label ?? "Jira",
    tenantLabel: connection?.tenantLabel ?? "Default workspace",
    baseUrl: parsed.baseUrl,
    email: parsed.email,
    apiToken: parsed.apiToken,
    projectKey:
      typeof parsed.projectKey === "string" && parsed.projectKey.trim()
        ? parsed.projectKey.trim()
        : undefined,
    queryScope: parsed.queryScope,
    originalEstimateFieldName:
      typeof parsed.originalEstimateFieldName === "string" && parsed.originalEstimateFieldName.trim()
        ? parsed.originalEstimateFieldName.trim()
        : undefined,
    remainingEstimateFieldName:
      typeof parsed.remainingEstimateFieldName === "string" && parsed.remainingEstimateFieldName.trim()
        ? parsed.remainingEstimateFieldName.trim()
        : undefined,
    completedEstimateFieldName:
      typeof parsed.completedEstimateFieldName === "string" && parsed.completedEstimateFieldName.trim()
        ? parsed.completedEstimateFieldName.trim()
        : undefined,
  };
}

export async function validateConnection(config: ConnectorFieldValues) {
  const parsed = parseConnectorFieldValues(config);
  const jiraConfig = buildJiraConfig(parsed);
  const validation = await validateJiraConnection(jiraConfig);
  if (
    typeof parsed.taskIconDisplayMode !== "string" ||
    !TASK_ICON_DISPLAY_MODES.has(parsed.taskIconDisplayMode)
  ) {
    return validation;
  }

  return {
    ...validation,
    normalizedConfig: {
      ...validation.normalizedConfig,
      taskIconDisplayMode: parsed.taskIconDisplayMode,
    },
  };
}

export async function syncConnection(
  connection: ConnectorPluginConnection,
  workItems: ConnectorSyncWorkItem[] = [],
) {
  const jiraConfig = buildJiraConfig(connection.config, connection);
  return await syncJiraConnection(jiraConfig, workItems);
}
