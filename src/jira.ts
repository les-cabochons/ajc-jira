import type {
  ConnectorImportCandidateInput,
  ConnectorPluginSyncResult,
  ConnectorSyncFieldUpdate,
  ConnectorSyncWorkItem,
  ConnectorSyncWorkItemUpdate,
  JiraQueryScope,
} from "./contract.js";
import { resolveEstimateSyncAction } from "./estimate-sync.js";

const CLOSED_STATUS_CATEGORY = "done";
const MAX_RESULTS = 200;
const MAX_CANDIDATE_NOTE_LENGTH = 4000;

export interface JiraConnectionInput {
  id?: string;
  label: string;
  tenantLabel: string;
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey?: string;
  queryScope: JiraQueryScope;
  originalEstimateFieldName?: string;
  remainingEstimateFieldName?: string;
  completedEstimateFieldName?: string;
}

interface JiraFieldDefinition {
  id?: string;
  key?: string;
  name?: string;
  schema?: {
    type?: string;
    custom?: string;
  };
}

export interface JiraResolvedFieldMetadata {
  configuredName: string;
  resolvedName: string;
  resolvedId: string;
  type?: string;
}

interface JiraSyncContext {
  items: ConnectorImportCandidateInput[];
  itemsBySourceId: Map<string, ConnectorImportCandidateInput>;
  fields: {
    originalEstimateField?: JiraResolvedFieldMetadata;
    remainingEstimateField?: JiraResolvedFieldMetadata;
    completedEstimateField?: JiraResolvedFieldMetadata;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
}

interface JiraIssue {
  id: string;
  key: string;
  fields?: Record<string, unknown>;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function createAuthHeader(email: string, apiToken: string) {
  return `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
}

function normalizeDisplayValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (value && typeof value === "object") {
    const displayName =
      "displayName" in value ? normalizeDisplayValue(value.displayName) : undefined;
    const name = "name" in value ? normalizeDisplayValue(value.name) : undefined;
    const key = "key" in value ? normalizeDisplayValue(value.key) : undefined;
    return displayName ?? name ?? key;
  }

  return undefined;
}

function extractDocumentText(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!Array.isArray(value) && typeof value === "object") {
    const node = value as {
      text?: unknown;
      content?: unknown;
    };

    const parts: string[] = [];
    const textValue = normalizeDisplayValue(node.text);
    if (textValue) {
      parts.push(textValue);
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        const childText = extractDocumentText(child);
        if (childText) {
          parts.push(childText);
        }
      }
    }

    const normalized = parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

function clampNote(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_CANDIDATE_NOTE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_CANDIDATE_NOTE_LENGTH - 3).trimEnd()}...`;
}

function compactFieldValues(values: Record<string, string | number | boolean | undefined>) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined),
  );
}

function getStatusName(issue: JiraIssue) {
  return normalizeDisplayValue((issue.fields?.status as { name?: string } | undefined)?.name ?? issue.fields?.status);
}

function isOpenIssue(issue: JiraIssue) {
  const statusCategoryKey = normalizeDisplayValue(
    (issue.fields?.status as { statusCategory?: { key?: string } } | undefined)?.statusCategory?.key,
  );
  return statusCategoryKey?.toLowerCase() !== CLOSED_STATUS_CATEGORY;
}

function isSubtask(issue: JiraIssue) {
  const issueType = issue.fields?.issuetype as { subtask?: unknown } | undefined;
  return issueType?.subtask === true || Boolean(issue.fields?.parent);
}

function buildIssueUrl(config: JiraConnectionInput, issueKey: string) {
  return `${normalizeBaseUrl(config.baseUrl)}/browse/${issueKey}`;
}

function buildJql(config: JiraConnectionInput, issueKeys?: string[]) {
  const clauses: string[] = [];

  if (issueKeys?.length) {
    clauses.push(`issuekey in (${issueKeys.map((issueKey) => `"${issueKey}"`).join(", ")})`);
    return `${clauses.join(" AND ")} ORDER BY updated DESC`;
  }

  if (config.projectKey?.trim()) {
    clauses.push(`project = "${config.projectKey.trim()}"`);
  }

  if (config.queryScope === "assigned_to_me") {
    clauses.push("assignee = currentUser()");
  }

  clauses.push("statusCategory != Done");

  return `${clauses.join(" AND ")} ORDER BY updated DESC`;
}

async function requestJira<T>(
  config: JiraConnectionInput,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${normalizeBaseUrl(config.baseUrl)}${pathname}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: createAuthHeader(config.email, config.apiToken),
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new Error(`Jira request failed: ${error instanceof Error ? error.message : "Network error"}`);
  }

  if (!response.ok) {
    let detail = response.statusText || "Request failed";
    try {
      const payload = (await response.json()) as { errorMessages?: string[]; message?: string };
      detail =
        payload.errorMessages?.join("; ").trim() ||
        payload.message?.trim() ||
        detail;
    } catch {
      // Ignore non-JSON error responses.
    }

    throw new Error(`Jira request failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as T;
}

async function searchIssues(
  config: JiraConnectionInput,
  jql: string,
  additionalFields: string[] = [],
): Promise<JiraIssue[]> {
  const body = {
    jql,
    maxResults: MAX_RESULTS,
    fields: Array.from(new Set([
      "summary",
      "description",
      "status",
      "assignee",
      "project",
      "issuetype",
      "priority",
      "parent",
      "subtasks",
      ...additionalFields,
    ])),
  };

  try {
    const response = await requestJira<JiraSearchResponse>(
      config,
      "/rest/api/3/search/jql",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    return response.issues ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("(404)") && !message.includes("(400)")) {
      throw error;
    }

    const fallback = await requestJira<JiraSearchResponse>(
      config,
      "/rest/api/3/search",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    return fallback.issues ?? [];
  }
}

async function updateJiraIssueFields(
  config: JiraConnectionInput,
  issueKey: string,
  fields: Record<string, number>,
) {
  if (Object.keys(fields).length === 0) {
    return;
  }

  await requestJira(
    config,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}`,
    {
      method: "PUT",
      body: JSON.stringify({ fields }),
    },
  );
}

function parsePriorityValue(value: unknown): number | undefined {
  const priorityName = normalizeDisplayValue((value as { name?: string } | undefined)?.name ?? value);
  if (!priorityName) {
    return undefined;
  }

  switch (priorityName.toLowerCase()) {
    case "highest":
      return 0;
    case "high":
      return 25;
    case "medium":
      return 50;
    case "low":
      return 75;
    case "lowest":
      return 100;
    default:
      return undefined;
  }
}

function normalizeConfiguredFieldName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLookupValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase() : undefined;
}

function parseEstimateValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 10_000) / 10_000);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed * 10_000) / 10_000);
    }
  }

  return undefined;
}

function requireSingleJiraFieldMatch(
  configuredFieldName: string,
  matches: JiraFieldDefinition[],
  matchKind: "id" | "name",
) {
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const fieldIds = matches
      .map((field) => field.id)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right));
    throw new Error(
      `Jira field "${configuredFieldName}" matched multiple fields by ${matchKind}. Use the exact field id instead${fieldIds.length > 0 ? `: ${fieldIds.join(", ")}` : "."}`,
    );
  }

  return undefined;
}

async function resolveJiraFieldMetadata(
  config: JiraConnectionInput,
  configuredFieldName: string | undefined,
): Promise<JiraResolvedFieldMetadata | undefined> {
  const normalizedConfiguredFieldName = normalizeConfiguredFieldName(configuredFieldName);
  if (!normalizedConfiguredFieldName) {
    return undefined;
  }

  const normalizedLookupValue = normalizeLookupValue(normalizedConfiguredFieldName);
  const fields = await requestJira<JiraFieldDefinition[]>(config, "/rest/api/3/field");

  const idMatch = requireSingleJiraFieldMatch(
    normalizedConfiguredFieldName,
    fields.filter((field) => normalizeLookupValue(field.id) === normalizedLookupValue),
    "id",
  );
  if (idMatch?.id) {
    return {
      configuredName: normalizedConfiguredFieldName,
      resolvedName: idMatch.name?.trim() || normalizedConfiguredFieldName,
      resolvedId: idMatch.id,
      type: idMatch.schema?.type?.trim() || undefined,
    };
  }

  const nameMatch = requireSingleJiraFieldMatch(
    normalizedConfiguredFieldName,
    fields.filter((field) => normalizeLookupValue(field.name) === normalizedLookupValue),
    "name",
  );
  if (nameMatch?.id) {
    return {
      configuredName: normalizedConfiguredFieldName,
      resolvedName: nameMatch.name?.trim() || normalizedConfiguredFieldName,
      resolvedId: nameMatch.id,
      type: nameMatch.schema?.type?.trim() || undefined,
    };
  }

  throw new Error(
    `Jira field "${normalizedConfiguredFieldName}" was not found. Enter the field name shown in Jira or the exact field id.`,
  );
}

function mapIssueToCandidate(
  config: JiraConnectionInput,
  issue: JiraIssue,
  allIssues: Map<string, JiraIssue>,
  baseIssueKeys: Set<string>,
  fieldIds?: {
    originalEstimateFieldId?: string;
    remainingEstimateFieldId?: string;
    completedEstimateFieldId?: string;
  },
): ConnectorImportCandidateInput | null {
  const title = normalizeDisplayValue(issue.fields?.summary);
  const issueType = normalizeDisplayValue((issue.fields?.issuetype as { name?: string } | undefined)?.name);
  const state = getStatusName(issue);
  const assignedTo = normalizeDisplayValue(issue.fields?.assignee);
  const projectName = normalizeDisplayValue(issue.fields?.project);
  const note = extractDocumentText(issue.fields?.description);
  const originalEstimateHours = fieldIds?.originalEstimateFieldId
    ? parseEstimateValue(issue.fields?.[fieldIds.originalEstimateFieldId])
    : undefined;
  const remainingEstimateHours = fieldIds?.remainingEstimateFieldId
    ? parseEstimateValue(issue.fields?.[fieldIds.remainingEstimateFieldId])
    : undefined;
  const completedEstimateHours = fieldIds?.completedEstimateFieldId
    ? parseEstimateValue(issue.fields?.[fieldIds.completedEstimateFieldId])
    : undefined;
  const parentIssue = issue.fields?.parent as JiraIssue | undefined;
  const parent = parentIssue?.key ? allIssues.get(parentIssue.key) ?? parentIssue : undefined;
  const parentTitle = normalizeDisplayValue(parent?.fields?.summary);
  const hasImportableParent = Boolean(parent && parentTitle && isOpenIssue(parent));
  const selectable = baseIssueKeys.has(issue.key);

  if (!title || !issueType || !isOpenIssue(issue)) {
    return null;
  }

  if (isSubtask(issue)) {
    return {
      source: "jira",
      connectionId: config.id ?? "unknown_connection",
      connectionLabel: config.label,
      tenantLabel: config.tenantLabel,
      sourceId: buildIssueUrl(config, issue.key),
      externalId: issue.key,
      sourceUrl: buildIssueUrl(config, issue.key),
      title,
      note: note ? clampNote(note) : undefined,
      projectName,
      workItemType: issueType,
      state,
      assignedTo,
      priority: parsePriorityValue(issue.fields?.priority),
      originalEstimateHours,
      remainingEstimateHours,
      completedEstimateHours,
      parentSourceId: hasImportableParent && parent ? buildIssueUrl(config, parent.key) : undefined,
      parentTitle: hasImportableParent ? parentTitle : undefined,
      depth: hasImportableParent ? 1 : 0,
      selectable,
      selected: selectable,
      childCount: 0,
    };
  }

  const subtasks = Array.isArray(issue.fields?.subtasks) ? (issue.fields?.subtasks as JiraIssue[]) : [];
  const includedChildCount = subtasks.filter((child) => {
    const resolvedChild = allIssues.get(child.key) ?? child;
    return baseIssueKeys.has(child.key) && isOpenIssue(resolvedChild);
  }).length;

  if (!selectable && includedChildCount === 0) {
    return null;
  }

  return {
    source: "jira",
    connectionId: config.id ?? "unknown_connection",
    connectionLabel: config.label,
    tenantLabel: config.tenantLabel,
    sourceId: buildIssueUrl(config, issue.key),
    externalId: issue.key,
    sourceUrl: buildIssueUrl(config, issue.key),
    title,
    note: note ? clampNote(note) : undefined,
    projectName,
    workItemType: issueType,
    state,
    assignedTo,
    priority: parsePriorityValue(issue.fields?.priority),
    originalEstimateHours,
    remainingEstimateHours,
    completedEstimateHours,
    depth: 0,
    selectable,
    selected: selectable,
    childCount: includedChildCount,
  };
}

async function fetchJiraSyncContext(config: JiraConnectionInput): Promise<JiraSyncContext> {
  const originalEstimateField = await resolveJiraFieldMetadata(config, config.originalEstimateFieldName);
  const remainingEstimateField = await resolveJiraFieldMetadata(config, config.remainingEstimateFieldName);
  const completedEstimateField = await resolveJiraFieldMetadata(config, config.completedEstimateFieldName);
  const additionalFields = [
    originalEstimateField?.resolvedId,
    remainingEstimateField?.resolvedId,
    completedEstimateField?.resolvedId,
  ].filter((value): value is string => Boolean(value));
  const baseIssues = await searchIssues(config, buildJql(config), additionalFields);
  if (baseIssues.length === 0) {
    return {
      items: [],
      itemsBySourceId: new Map(),
      fields: {
        originalEstimateField,
        remainingEstimateField,
        completedEstimateField,
      },
    };
  }

  const baseIssueKeys = new Set(baseIssues.map((issue) => issue.key));
  const parentKeys = Array.from(
    new Set(
      baseIssues
        .map((issue) => normalizeDisplayValue((issue.fields?.parent as { key?: string } | undefined)?.key))
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .filter((value) => !baseIssueKeys.has(value)),
    ),
  );
  const parentIssues = parentKeys.length > 0 ? await searchIssues(config, buildJql(config, parentKeys), additionalFields) : [];
  const allIssues = new Map<string, JiraIssue>(
    [...baseIssues, ...parentIssues].map((issue) => [issue.key, issue] as const),
  );

  const items = Array.from(allIssues.values())
    .map((issue) =>
      mapIssueToCandidate(config, issue, allIssues, baseIssueKeys, {
        originalEstimateFieldId: originalEstimateField?.resolvedId,
        remainingEstimateFieldId: remainingEstimateField?.resolvedId,
        completedEstimateFieldId: completedEstimateField?.resolvedId,
      }),
    )
    .filter((item): item is ConnectorImportCandidateInput => Boolean(item))
    .sort((left, right) => {
      if (left.connectionId !== right.connectionId) {
        return left.connectionId.localeCompare(right.connectionId);
      }

      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }

      if ((left.parentSourceId ?? "") !== (right.parentSourceId ?? "")) {
        return (left.parentSourceId ?? "").localeCompare(right.parentSourceId ?? "");
      }

      return left.title.localeCompare(right.title);
    });

  return {
    items,
    itemsBySourceId: new Map(items.map((item) => [item.sourceId, item] as const)),
    fields: {
      originalEstimateField,
      remainingEstimateField,
      completedEstimateField,
    },
  };
}

function buildJiraEstimateFieldUpdate(
  localWorkItem: ConnectorSyncWorkItem,
  remoteItem: ConnectorImportCandidateInput,
  fieldKey: "originalEstimateHours" | "remainingEstimateHours" | "completedEstimateHours",
): ConnectorSyncFieldUpdate | null {
  const fieldSyncState = localWorkItem.estimateSync?.[fieldKey];
  if (
    remoteItem[fieldKey] === undefined &&
    fieldSyncState?.remoteValue === undefined &&
    fieldSyncState?.baselineValue === undefined
  ) {
    return null;
  }

  const action = resolveEstimateSyncAction({
    localValue: localWorkItem[fieldKey],
    remoteValue: remoteItem[fieldKey],
    baselineValue: fieldSyncState?.baselineValue,
    resolution: fieldSyncState?.resolution,
  });

  return {
    status:
      action.status === "push"
        ? "pushed"
        : action.status === "pull"
          ? "pulled"
          : action.status,
    localValue: action.localValue,
    remoteValue: action.remoteValue,
    baselineValue: action.baselineValue,
    nextBaselineValue: "nextBaselineValue" in action ? action.nextBaselineValue : undefined,
  };
}

async function buildJiraWorkItemUpdates(
  config: JiraConnectionInput,
  syncContext: JiraSyncContext,
  workItems: ConnectorSyncWorkItem[],
): Promise<ConnectorSyncWorkItemUpdate[]> {
  const updates: ConnectorSyncWorkItemUpdate[] = [];
  const mappedFieldIds = {
    originalEstimateHours: syncContext.fields.originalEstimateField?.resolvedId,
    remainingEstimateHours: syncContext.fields.remainingEstimateField?.resolvedId,
    completedEstimateHours: syncContext.fields.completedEstimateField?.resolvedId,
  } as const;

  for (const workItem of workItems) {
    const remoteItem = syncContext.itemsBySourceId.get(workItem.sourceId);
    if (!remoteItem) {
      continue;
    }

    const fieldUpdates: ConnectorSyncWorkItemUpdate["fields"] = {};

    for (const fieldKey of Object.keys(mappedFieldIds) as Array<keyof typeof mappedFieldIds>) {
      const mappedFieldId = mappedFieldIds[fieldKey];
      if (!mappedFieldId) {
        continue;
      }

      const fieldUpdate = buildJiraEstimateFieldUpdate(workItem, remoteItem, fieldKey);
      if (!fieldUpdate) {
        continue;
      }
      fieldUpdates[fieldKey] = fieldUpdate;
    }

    if (Object.keys(fieldUpdates).length === 0) {
      continue;
    }

    for (const fieldKey of Object.keys(fieldUpdates) as Array<keyof typeof fieldUpdates>) {
      const mappedFieldId = mappedFieldIds[fieldKey];
      const fieldUpdate = fieldUpdates[fieldKey];
      if (!mappedFieldId || fieldUpdate?.status !== "pushed" || typeof workItem[fieldKey] !== "number") {
        continue;
      }

      try {
        await updateJiraIssueFields(config, remoteItem.externalId, {
          [mappedFieldId]: workItem[fieldKey]!,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to update Jira issue.";
        fieldUpdates[fieldKey] = {
          ...fieldUpdate,
          status: "error",
          message,
        };
      }
    }

    updates.push({
      localWorkItemId: workItem.localWorkItemId,
      sourceId: workItem.sourceId,
      fields: fieldUpdates,
    });
  }

  return updates;
}

export async function validateJiraConnection(config: JiraConnectionInput) {
  const account = await requestJira<{ accountId?: string }>(config, "/rest/api/3/myself");
  const originalEstimateField = await resolveJiraFieldMetadata(config, config.originalEstimateFieldName);
  const remainingEstimateField = await resolveJiraFieldMetadata(config, config.remainingEstimateFieldName);
  const completedEstimateField = await resolveJiraFieldMetadata(config, config.completedEstimateFieldName);
  if (!account.accountId) {
    throw new Error(`Jira authentication succeeded but the current account could not be resolved for ${config.baseUrl}.`);
  }

  return {
    normalizedConfig: compactFieldValues({
      baseUrl: normalizeBaseUrl(config.baseUrl),
      email: config.email.trim(),
      apiToken: config.apiToken,
      projectKey: config.projectKey?.trim() || undefined,
      queryScope: config.queryScope,
      originalEstimateFieldName: originalEstimateField?.configuredName,
      remainingEstimateFieldName: remainingEstimateField?.configuredName,
      completedEstimateFieldName: completedEstimateField?.configuredName,
    }),
    connectionSummary: compactFieldValues({
      site: normalizeBaseUrl(config.baseUrl),
      projectKey: config.projectKey?.trim() || "All projects",
      scope: config.queryScope === "assigned_to_me" ? "Assigned to me" : "Open issues",
      originalEstimateFieldName: originalEstimateField?.configuredName,
      remainingEstimateFieldName: remainingEstimateField?.configuredName,
      completedEstimateFieldName: completedEstimateField?.configuredName,
    }),
  };
}

export async function fetchJiraImportCandidates(config: JiraConnectionInput) {
  const syncContext = await fetchJiraSyncContext(config);
  return { items: syncContext.items };
}

export async function syncJiraConnection(
  config: JiraConnectionInput,
  workItems: ConnectorSyncWorkItem[] = [],
): Promise<ConnectorPluginSyncResult> {
  const syncContext = await fetchJiraSyncContext(config);
  return {
    items: syncContext.items,
    workItemUpdates: await buildJiraWorkItemUpdates(config, syncContext, workItems),
  };
}
