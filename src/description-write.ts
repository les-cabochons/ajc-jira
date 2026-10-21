import type {
  BacklogWriteDescriptionRequest,
  BacklogWriteDescriptionResult,
} from "./contract.js";
import { describeJiraDescriptionFully, MAX_LOST } from "./description.js";
import { documentOf } from "./description-nested.js";
import { checkPreservation } from "./description-guard.js";
import { patchDescriptionAdf } from "./description-patch.js";
import { fetchDescribedIssue, requireIssueKey } from "./description-source.js";
import { buildIssueUrl, describeIssue, requestJira, type JiraConnectionInput } from "./jira.js";
import { markdownToAdf, type AdfDocument } from "./markdown-adf.js";

function isDocument(value: unknown): value is { type: "doc"; content: unknown[] } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "doc";
}

/**
 * The longest description Jira Cloud takes, 32,767 characters. Jira does
 * not document how it measures an ADF description, so the write measures the
 * ADF as JSON, which is never shorter than its text.
 */
export const JIRA_DESCRIPTION_MAX_LENGTH = 32_767;

/** Whether a refused edit is how Jira answers a conflicting update. */
function isConflictingUpdate(error: unknown) {
  return error instanceof Error && /request failed \(409\)/.test(error.message);
}

/**
 * Writes the user's description, unless the issue's description changed since
 * Ajour read it: the current one, converted as a sync converts it, must still
 * be `expected`. Jira's issue edit has no revision test, so this check runs on
 * the issue read just before the write, one request earlier. The blocks the
 * user did not change keep their ADF.
 */
export async function writeJiraDescription(
  config: JiraConnectionInput,
  request: BacklogWriteDescriptionRequest,
): Promise<BacklogWriteDescriptionResult> {
  const key = requireIssueKey(request.sourceId);
  const issue = await fetchDescribedIssue(config, key);
  const context = { issueUrl: buildIssueUrl(config, issue.key ?? key), attachments: issue.fields?.attachment };
  const current = describeIssue(config, issue);
  if (current.text !== request.expected) {
    return { outcome: "conflict", description: current };
  }
  // The same text can come from formatting a colleague added since Ajour read
  // it, which the write would erase. Lossy text is written only when the user
  // saw each of its losses and saved anyway; even then, the blocks they did
  // not change keep their ADF, formatting included. Cut text never is, nor
  // text that loses more than the names Ajour can show.
  const allowed = request.allowedLoss ?? [];
  const lost = describeJiraDescriptionFully(issue.fields?.description, context).lost ?? [];
  const unseen = lost.filter((loss) => !allowed.includes(loss));
  if (current.cut || lost.length > MAX_LOST || unseen.length > 0) {
    throw new Error(
      current.cut
        ? "This description is longer than Ajour keeps. Edit it in Jira."
        : lost.length > MAX_LOST
          ? "This description loses more kinds of formatting than Ajour can name. Edit it in Jira."
          : `Writing it would lose its ${unseen.join(", ")} in Jira. Edit it there.`,
    );
  }

  let description: AdfDocument | null = null;
  if (request.text.trim()) {
    const source = issue.fields?.description;
    description = isDocument(source) ? patchDescriptionAdf(source, request.text, context) : markdownToAdf(request.text);
    // Checked against the source, independently of the patch: every node the
    // user left alone, at any depth, must be written as it was; one that is
    // not loses only what the user allowed, or nothing goes. No written node
    // may hold ids or attributes it could not have.
    if (isDocument(source)) {
      const report = checkPreservation(source, description, context);
      const unallowed = report.rebuilt.some((node) => {
        const nodeLost = describeJiraDescriptionFully(documentOf(node), context).lost ?? [];
        return nodeLost.length === 0 || nodeLost.some((loss) => !allowed.includes(loss));
      });
      if (report.invalid.length > 0 || unallowed) {
        throw new Error(
          "Ajour cannot write this edit without changing parts of the description you did not edit. Edit it in Jira.",
        );
      }
    }
  }
  const size = JSON.stringify(description).length;
  if (description && size > JIRA_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `This description is too long for Jira: ${size.toLocaleString("en-US")} of ${JIRA_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters once converted.`,
    );
  }

  try {
    await requestJira(config, `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ fields: { description } }),
    });
  } catch (error) {
    // A conflicting update, as Jira answers one: if someone changed the
    // description in between, that is a conflict. Any other refusal, such as a
    // missing permission, stays.
    if (!isConflictingUpdate(error)) throw error;
    const now = await fetchDescribedIssue(config, key).catch(() => undefined);
    if (now) {
      const described = describeIssue(config, now);
      if (described.text !== request.expected) return { outcome: "conflict", description: described };
    }
    throw error;
  }
  return { outcome: "written", description: describeIssue(config, await fetchDescribedIssue(config, key)) };
}
