import type {
  BacklogReadDescriptionRequest,
  BacklogReadDescriptionResult,
} from "./contract.js";
import {
  describeIssue,
  parseJiraIssueKey,
  requestJira,
  type JiraConnectionInput,
  type JiraIssue,
} from "./jira.js";

export function requireIssueKey(sourceId: string) {
  const key = parseJiraIssueKey(sourceId);
  if (!key) {
    throw new Error(`"${sourceId}" is not a Jira issue.`);
  }
  return key;
}

/** The issue's description and the attachments its images point at. */
export async function fetchDescribedIssue(config: JiraConnectionInput, key: string) {
  return await requestJira<JiraIssue>(
    config,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=description,attachment`,
  );
}

/**
 * The issue's current description, as Ajour syncs it. Ajour asks when the
 * user starts editing and again before it saves, to merge with the source.
 */
export async function readJiraDescription(
  config: JiraConnectionInput,
  request: BacklogReadDescriptionRequest,
): Promise<BacklogReadDescriptionResult> {
  const key = requireIssueKey(request.sourceId);
  return { description: describeIssue(config, await fetchDescribedIssue(config, key)) };
}
