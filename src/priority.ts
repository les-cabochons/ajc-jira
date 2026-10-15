import type { ConnectorPriorityLevel } from "./contract.js";

/**
 * The one place that maps Jira's default priority names to Ajour's priority
 * levels, in both directions. Jira has five priorities and Ajour has four
 * levels, so Lowest reads as low and a low write goes back as Low.
 */

/** Ajour level for each Jira priority name, lowercased. */
const LEVEL_BY_JIRA_NAME = new Map<string, ConnectorPriorityLevel>([
  ["highest", "urgent"],
  ["high", "high"],
  ["medium", "medium"],
  ["low", "low"],
  ["lowest", "low"],
]);

/** Jira priority name a settle writes for each Ajour level. */
const JIRA_NAME_BY_LEVEL: Record<ConnectorPriorityLevel, string> = {
  urgent: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * The Ajour level for a Jira priority name. Undefined for a missing name or a
 * custom priority the default scheme does not have.
 */
export function jiraPriorityToLevel(name: string | undefined): ConnectorPriorityLevel | undefined {
  return name === undefined ? undefined : LEVEL_BY_JIRA_NAME.get(name.trim().toLowerCase());
}

/**
 * The Jira priority name for an Ajour level. Undefined when the value is not a
 * level, since the request comes from outside the plugin.
 */
export function levelToJiraPriority(level: string): string | undefined {
  return Object.hasOwn(JIRA_NAME_BY_LEVEL, level)
    ? JIRA_NAME_BY_LEVEL[level as ConnectorPriorityLevel]
    : undefined;
}
