import type {
  ConnectorSettleState,
  ConnectorSettleStatesResult,
  ConnectorSettleWriteRequest,
  ConnectorSettleWriteResult,
} from "./contract.js";
import {
  getStatusCategory,
  getStatusName,
  normalizeDisplayValue,
  parseJiraIssueKey,
  parsePriorityValue,
  requestJira,
  type JiraConnectionInput,
  type JiraIssue,
} from "./jira.js";

/**
 * Settling a backlog item from Ajour: the statuses an issue can move to, and
 * the write of a new status, priority or both. See Ajour's ADR 0001.
 */

/** Jira's status categories, in workflow order. */
const CATEGORY_ORDER = ["new", "indeterminate", "done"];

/** Ajour's source priority for each Jira priority, as sync reads it. */
const PRIORITY_NAMES = new Map([
  [0, "Highest"],
  [25, "High"],
  [50, "Medium"],
  [75, "Low"],
  [100, "Lowest"],
]);

interface JiraStatus {
  name?: unknown;
  statusCategory?: { key?: unknown; name?: unknown };
}

interface JiraTransitionsResponse {
  transitions?: Array<{ id?: unknown; to?: JiraStatus }>;
}

function requireIssueKey(sourceId: string) {
  const key = parseJiraIssueKey(sourceId);
  if (!key) {
    throw new Error(`"${sourceId}" is not a Jira issue.`);
  }
  return key;
}

function toSettleState(status: JiraStatus | undefined) {
  const name = normalizeDisplayValue(status?.name);
  const categoryKey = normalizeDisplayValue(status?.statusCategory?.key)?.toLowerCase();
  const category = normalizeDisplayValue(status?.statusCategory?.name);
  if (!name || !category) {
    return undefined;
  }
  return { state: { name, category, done: categoryKey === "done" }, categoryKey };
}

async function fetchIssue(config: JiraConnectionInput, key: string) {
  return await requestJira<JiraIssue>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status,priority`,
  );
}

async function fetchTransitions(config: JiraConnectionInput, key: string) {
  const response = await requestJira<JiraTransitionsResponse>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
  );
  return response.transitions ?? [];
}

/**
 * The issue's current status and the statuses its transitions lead to, by
 * category in workflow order. Done-category statuses are marked done.
 */
export async function listJiraSettleStates(
  config: JiraConnectionInput,
  sourceId: string,
): Promise<ConnectorSettleStatesResult> {
  const key = requireIssueKey(sourceId);
  const [issue, transitions] = await Promise.all([
    fetchIssue(config, key),
    fetchTransitions(config, key),
  ]);

  const entries = [
    toSettleState(issue.fields?.status as JiraStatus | undefined),
    ...transitions.map((transition) => toSettleState(transition.to)),
  ].filter((entry) => entry !== undefined);
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    const name = entry.state.name.toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const rank = (categoryKey: string | undefined) => {
    const index = CATEGORY_ORDER.indexOf(categoryKey ?? "");
    return index === -1 ? CATEGORY_ORDER.length : index;
  };

  return {
    states: unique
      .map((entry, index) => ({ entry, index }))
      .sort(
        (left, right) =>
          rank(left.entry.categoryKey) - rank(right.entry.categoryKey) ||
          left.index - right.index,
      )
      .map(({ entry }): ConnectorSettleState => entry.state),
  };
}

/**
 * Writes the priority first, then moves the issue through the transition that
 * leads to the new status. Jira workflows often lock fields once an issue is
 * done, so the priority must go in before the transition.
 */
export async function writeJiraSettle(
  config: JiraConnectionInput,
  request: ConnectorSettleWriteRequest,
): Promise<ConnectorSettleWriteResult> {
  const key = requireIssueKey(request.sourceId);
  if (request.state === undefined && request.priority === undefined) {
    throw new Error("A settle write needs a state, a priority or both.");
  }

  if (request.priority !== undefined) {
    const priorityName = PRIORITY_NAMES.get(request.priority);
    if (!priorityName) {
      throw new Error(`Jira has no priority for the value ${request.priority}.`);
    }
    await requestJira(config, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { priority: { name: priorityName } } }),
    });
  }

  if (request.state !== undefined) {
    const current = getStatusName(await fetchIssue(config, key));
    if (current?.toLowerCase() !== request.state.trim().toLowerCase()) {
      const target = request.state.trim().toLowerCase();
      const transition = (await fetchTransitions(config, key)).find(
        (candidate) =>
          normalizeDisplayValue(candidate.to?.name)?.toLowerCase() === target,
      );
      const transitionId = normalizeDisplayValue(transition?.id);
      if (!transitionId) {
        throw new Error(
          `Jira has no transition from "${current ?? "its status"}" to "${request.state}" for ${key}.`,
        );
      }
      await requestJira(
        config,
        `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
        {
          method: "POST",
          body: JSON.stringify({ transition: { id: transitionId } }),
        },
      );
    }
  }

  const updated = await fetchIssue(config, key);
  const category = getStatusCategory(updated);
  return {
    state: getStatusName(updated),
    stateCategory: category.name,
    stateDone: category.key === "done",
    priority: parsePriorityValue(updated.fields?.priority),
  };
}
