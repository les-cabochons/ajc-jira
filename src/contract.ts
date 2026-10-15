export type JiraQueryScope = "assigned_to_me" | "project_open_issues";

/** Ajour's priority levels. The plugin maps Jira priorities to these. */
export type ConnectorPriorityLevel = "urgent" | "high" | "medium" | "low";

export type ConnectorFieldValue = string | number | boolean;
export type ConnectorFieldValues = Record<string, ConnectorFieldValue>;

export function parseConnectorFieldValues(value: unknown): ConnectorFieldValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector field values must be an object.");
  }

  const entries = Object.entries(value);
  if (
    entries.some(
      ([, fieldValue]) =>
        typeof fieldValue !== "string" &&
        typeof fieldValue !== "number" &&
        typeof fieldValue !== "boolean",
    )
  ) {
    throw new Error("Connector field values must contain only primitive values.");
  }

  return Object.fromEntries(entries) as ConnectorFieldValues;
}

export interface ConnectorPluginConnection {
  id: string;
  pluginId: string;
  label: string;
  tenantLabel: string;
  autoSync: boolean;
  autoSyncIntervalMinutes: number;
  connectedAt: number;
  lastSyncAt?: number;
  lastError?: string;
  config: ConnectorFieldValues;
}

export interface ConnectorImportCandidateInput {
  source: string;
  connectionId: string;
  connectionLabel: string;
  tenantLabel: string;
  sourceId: string;
  externalId: string;
  sourceUrl?: string;
  title: string;
  note?: string;
  projectName?: string;
  workItemType: string;
  state?: string;
  /** The status category's name, such as "In Progress". */
  stateCategory?: string;
  /** True in the Done category. Ajour archives done items. */
  stateDone?: boolean;
  assignedTo?: string;
  /** Omitted when the Jira priority maps to no level. */
  priority?: ConnectorPriorityLevel;
  originalEstimateHours?: number;
  remainingEstimateHours?: number;
  completedEstimateHours?: number;
  parentSourceId?: string;
  parentTitle?: string;
  depth: 0 | 1;
  selectable: boolean;
  selected?: boolean;
  childCount: number;
  pushedAt?: number;
}

export interface ConnectorSyncEstimateFieldState {
  baselineValue?: number;
  remoteValue?: number;
  resolution?: "keep_local";
}

export interface ConnectorSyncWorkItem {
  localWorkItemId: string;
  sourceId: string;
  originalEstimateHours?: number;
  remainingEstimateHours?: number;
  completedEstimateHours?: number;
  estimateSync?: {
    originalEstimateHours?: ConnectorSyncEstimateFieldState;
    remainingEstimateHours?: ConnectorSyncEstimateFieldState;
    completedEstimateHours?: ConnectorSyncEstimateFieldState;
  };
}

export interface ConnectorSyncFieldUpdate {
  status: "noop" | "pushed" | "pulled" | "conflict" | "error";
  localValue?: number;
  remoteValue?: number;
  baselineValue?: number;
  nextBaselineValue?: number;
  message?: string;
}

export interface ConnectorSyncWorkItemUpdate {
  localWorkItemId: string;
  sourceId: string;
  fields: {
    originalEstimateHours?: ConnectorSyncFieldUpdate;
    remainingEstimateHours?: ConnectorSyncFieldUpdate;
    completedEstimateHours?: ConnectorSyncFieldUpdate;
  };
}

/** A state a backlog item can move to when it is settled. */
export interface ConnectorSettleState {
  name: string;
  category: string;
  done: boolean;
}

export interface ConnectorSettleStatesRequest {
  sourceId: string;
}

export interface ConnectorSettleStatesResult {
  states: ConnectorSettleState[];
}

/** Only the fields the settle changed. */
export interface ConnectorSettleWriteRequest {
  sourceId: string;
  state?: string;
  priority?: ConnectorPriorityLevel;
}

/** The issue's values in Jira after the write. */
export interface ConnectorSettleWriteResult {
  state?: string;
  stateCategory?: string;
  stateDone?: boolean;
  priority?: ConnectorPriorityLevel;
}

export interface ConnectorPluginSyncResult {
  items: ConnectorImportCandidateInput[];
  workItemUpdates?: ConnectorSyncWorkItemUpdate[];
}
