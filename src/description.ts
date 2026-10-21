import { adfToMarkdown, adfToMarkdownWithLosses, type AdfImageContext } from "./adf-markdown.js";
import type { ConnectorSyncedDescription } from "./contract.js";
import { markdownToAdf } from "./markdown-adf.js";

/** The most of a description Ajour stores (Ajour's ADR 0009). */
export const MAX_DESCRIPTION_LENGTH = 64_000;

/** The most names Ajour takes in `lost`. */
export const MAX_LOST = 20;

/**
 * What `lost` names for a description whose Markdown would not write back as
 * itself: an edit in Ajour would change parts the user never touched, so
 * Ajour keeps it read-only.
 */
export const NOT_WRITABLE_EXACTLY = "formatting Ajour cannot write back";

/** Whether Markdown read from ADF writes back as ADF that reads as itself. */
function writesBackExactly(markdown: string, context: AdfImageContext) {
  return (adfToMarkdown(markdownToAdf(markdown), context) ?? "") === markdown;
}

/**
 * An issue's description as Ajour syncs it: Markdown, what the conversion
 * from ADF dropped, and whether it was cut to what Ajour stores. Ajour takes
 * at most 20 names in `lost`; the write checks every one.
 */
export function describeJiraDescription(value: unknown, context: AdfImageContext): ConnectorSyncedDescription {
  const described = describeJiraDescriptionFully(value, context);
  return described.lost && described.lost.length > MAX_LOST
    ? { ...described, lost: described.lost.slice(0, MAX_LOST) }
    : described;
}

/** The same, with every name of what the conversion dropped. */
export function describeJiraDescriptionFully(value: unknown, context: AdfImageContext): ConnectorSyncedDescription {
  const converted = adfToMarkdownWithLosses(value, context);
  let text = converted.markdown ?? "";
  let lost = converted.lost;
  if (text.length <= MAX_DESCRIPTION_LENGTH && !writesBackExactly(text, context)) {
    lost = [...lost, NOT_WRITABLE_EXACTLY];
  }
  const cut = text.length > MAX_DESCRIPTION_LENGTH;
  if (cut) {
    text = text.slice(0, MAX_DESCRIPTION_LENGTH);
    // Never leave half of a character made of two code units.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return {
    text,
    ...(lost.length > 0 ? { lost } : {}),
    ...(cut ? { cut: true } : {}),
  };
}
