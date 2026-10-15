// Converts a Jira description in Atlassian Document Format to the markdown
// Ajour renders in backlog item notes. Ajour keeps single line breaks, so a
// hard break is a plain newline. Attachments need the user's Jira session and
// are left out.

type AdfMark = {
  type?: unknown;
  attrs?: Record<string, unknown>;
};

type AdfNode = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: unknown;
  content?: unknown;
};

export function adfToMarkdown(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!isNode(value)) {
    return undefined;
  }

  const markdown = renderBlocks(childrenOf(value))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown.length > 0 ? markdown : undefined;
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function attr(node: AdfNode, name: string): unknown {
  return node.attrs?.[name];
}

function stringAttr(node: AdfNode, name: string): string | undefined {
  const value = attr(node, name);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function renderBlocks(nodes: AdfNode[], separator = "\n\n"): string {
  return nodes
    .map(renderBlock)
    .filter((block) => block.trim().length > 0)
    .join(separator);
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return escapeLineStarts(renderInlines(childrenOf(node)));
    case "heading": {
      const level = Math.min(Math.max(Number(attr(node, "level")) || 1, 1), 6);
      const text = singleLine(renderInlines(childrenOf(node)));
      return text ? `${"#".repeat(level)} ${text}` : "";
    }
    case "bulletList":
    case "decisionList":
      return renderList(childrenOf(node), () => "- ");
    case "orderedList": {
      const start = Number(attr(node, "order")) || 1;
      return renderList(childrenOf(node), (index) => `${start + index}. `);
    }
    case "taskList":
      return renderList(childrenOf(node), (_index, item) =>
        attr(item, "state") === "DONE" ? "- [x] " : "- [ ] ",
      );
    case "listItem":
    case "taskItem":
    case "decisionItem":
      return renderListItemBody(node);
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
    case "panel":
      return prefixLines(renderBlocks(childrenOf(node)), "> ");
    case "rule":
      return "---";
    case "table":
      return renderTable(node);
    case "expand":
    case "nestedExpand": {
      const title = stringAttr(node, "title");
      const body = renderBlocks(childrenOf(node));
      return title ? `**${escapeText(title)}**\n\n${body}` : body;
    }
    case "blockCard":
    case "embedCard": {
      const url = stringAttr(node, "url");
      return url ? `<${url}>` : "";
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "";
    default:
      return node.text !== undefined || isInlineType(node.type)
        ? escapeLineStarts(renderInline(node))
        : renderBlocks(childrenOf(node));
  }
}

function isInlineType(type: unknown) {
  return (
    type === "text" ||
    type === "hardBreak" ||
    type === "mention" ||
    type === "emoji" ||
    type === "inlineCard" ||
    type === "date" ||
    type === "status"
  );
}

function renderList(
  items: AdfNode[],
  marker: (index: number, item: AdfNode) => string,
): string {
  return items
    .map((item, index) => {
      const prefix = marker(index, item);
      const body = renderListItemBody(item);
      return prefix + indentContinuation(body, " ".repeat(prefix.length));
    })
    .join("\n");
}

function renderListItemBody(item: AdfNode): string {
  const children = childrenOf(item);
  // Task and decision items hold inline content directly.
  if (children.every((child) => isInlineType(child.type))) {
    return escapeLineStarts(renderInlines(children));
  }
  return renderBlocks(children, "\n");
}

function renderCodeBlock(node: AdfNode): string {
  const code = childrenOf(node)
    .map((child) => (typeof child.text === "string" ? child.text : ""))
    .join("")
    .replace(/\n+$/, "");
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  const language = stringAttr(node, "language") ?? "";
  return `${fence}${language}\n${code}\n${fence}`;
}

function renderTable(node: AdfNode): string {
  const rows = childrenOf(node)
    .filter((row) => row.type === "tableRow")
    .map((row) =>
      childrenOf(row).map((cell) =>
        singleLine(renderBlocks(childrenOf(cell), " ")),
      ),
    )
    .filter((row) => row.length > 0);
  const [header, ...body] = rows;
  if (!header) {
    return "";
  }

  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [
    line(header),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

function renderInlines(nodes: AdfNode[]): string {
  return nodes.map(renderInline).join("");
}

function renderInline(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? applyMarks(node.text, node.marks) : "";
    case "hardBreak":
      return "\n";
    case "mention":
      return escapeText(stringAttr(node, "text") ?? "");
    case "emoji":
      return stringAttr(node, "text") ?? stringAttr(node, "shortName") ?? "";
    case "inlineCard": {
      const url = stringAttr(node, "url");
      return url ? `<${url}>` : "";
    }
    case "date": {
      const timestamp = Number(attr(node, "timestamp"));
      return Number.isFinite(timestamp)
        ? new Date(timestamp).toISOString().slice(0, 10)
        : "";
    }
    case "status":
      return escapeText(stringAttr(node, "text") ?? "");
    default:
      return typeof node.text === "string"
        ? escapeText(node.text)
        : renderInlines(childrenOf(node));
  }
}

function applyMarks(text: string, marks: unknown): string {
  const markList = Array.isArray(marks) ? (marks as AdfMark[]) : [];
  const types = new Set(markList.map((mark) => mark.type));

  let result: string;
  if (types.has("code")) {
    const fence = "`".repeat(longestRun(text, "`") + 1);
    const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
    result = `${fence}${padding}${text}${padding}${fence}`;
  } else {
    result = escapeText(text);
    if (types.has("strike")) result = wrap(result, "~~");
    if (types.has("em")) result = wrap(result, "_");
    if (types.has("strong")) result = wrap(result, "**");
  }

  const link = markList.find((mark) => mark.type === "link");
  const href = link?.attrs?.href;
  if (typeof href === "string" && href.length > 0) {
    result = `[${result}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
  }
  return result;
}

// Markers must touch the text they wrap, so surrounding spaces move outside.
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || match[2] === "") {
    return text;
  }
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]~|]/g, "\\$&");
}

// Text that starts a line with "#", ">", "- ", "+ ", "1. " or a run of "-" or
// "=" would turn into a heading, quote or list. Leading spaces would turn into
// a code block.
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .trimStart()
        .replace(/^(#{1,6}(?=\s|$)|>|[-+](?=\s)|[-=](?=[-=\s]*$)|\d+(?=[.)]\s))/, (token: string) =>
          /^\d/.test(token) ? `${token}\\` : `\\${token}`,
        ),
    )
    .join("\n");
}

function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

function indentContinuation(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line.length === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
