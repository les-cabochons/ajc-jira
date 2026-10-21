// Converts a Jira description in Atlassian Document Format (ADF) to the
// Markdown Ajour edits, and names what Markdown cannot hold (Ajour's ADR
// 0009). Only what is known to come back through markdown-adf.ts leaves a
// description editable: any node, mark or attribute the reader does not know
// is named "other formatting". Ajour keeps single line breaks, so a hard break
// is a plain newline. Mentions become `[@Name](mention:<accountId>)`, and
// images Markdown images whose address carries what Jira needs to rebuild
// them, so neither ever counts as lost.

export type AdfNode = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: unknown;
  content?: unknown;
};

type AdfMark = {
  type?: unknown;
  attrs?: Record<string, unknown>;
};

/** What an image's address is built from: the issue and its attachments. */
export interface AdfImageContext {
  /** The issue's URL, the address of an image whose attachment is not found. */
  issueUrl?: string;
  /** The issue's `attachment` field. */
  attachments?: unknown;
}

/**
 * Where an image's address carries the media Jira needs to rebuild it, as
 * `<attachment URL>#ajour-media?id=…&collection=…`. Images never count as lost.
 */
export const MEDIA_MARK = "#ajour-media?";

/** One top-level block of a description and its Markdown. */
export interface AdfMarkdownPart {
  /** The block's index in the document's content. */
  index: number;
  markdown: string;
}

export function adfToMarkdown(value: unknown, context: AdfImageContext = {}): string | undefined {
  return adfToMarkdownWithLosses(value, context).markdown;
}

/**
 * The same conversion, naming what Markdown cannot hold and the conversion
 * dropped, such as "text colour".
 */
export function adfToMarkdownWithLosses(
  value: unknown,
  context: AdfImageContext = {},
): { markdown: string | undefined; lost: string[] } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return { markdown: trimmed.length > 0 ? trimmed : undefined, lost: [] };
  }
  return converting(context, () => {
    const markdown = (readParts(value)?.parts ?? []).map((part) => part.markdown).join("\n\n");
    return markdown.length > 0 ? markdown : undefined;
  });
}

/**
 * The description's top-level blocks with their Markdown, which joined by a
 * blank line is the whole Markdown. Blocks with none, as Jira's empty lines,
 * have no part. Undefined when the value is not a document.
 */
export function adfToMarkdownParts(
  value: unknown,
  context: AdfImageContext = {},
): { content: AdfNode[]; parts: AdfMarkdownPart[] } | undefined {
  return converting(context, () => readParts(value)).markdown;
}

/** The context and losses of the conversion under way. */
let images: AdfImageContext = {};
let losses: Set<string> | undefined;
/** Whether a table cell is being read, where every `|` must be escaped. */
let inCell = false;

function converting<T>(context: AdfImageContext, convert: () => T): { markdown: T; lost: string[] } {
  const previous = { images, losses };
  images = context;
  losses = new Set();
  try {
    const markdown = convert();
    return { markdown, lost: [...losses] };
  } finally {
    images = previous.images;
    losses = previous.losses;
  }
}

function lose(what: string) {
  losses?.add(what);
}

function readParts(value: unknown) {
  if (!isNode(value)) {
    return undefined;
  }
  if (value.type !== "doc") lose("other formatting");
  const content = childrenOf(value);
  const parts: AdfMarkdownPart[] = [];
  content.forEach((node, index) => {
    const markdown = renderBlock(node, true);
    if (markdown.trim().length > 0) parts.push({ index, markdown });
  });
  return { content, parts };
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function marksOf(node: AdfNode): AdfMark[] {
  return Array.isArray(node.marks) ? node.marks.filter(isNode) : [];
}

function attr(node: AdfNode, name: string): unknown {
  return node.attrs?.[name];
}

function stringAttr(node: AdfNode, name: string): string | undefined {
  const value = attr(node, name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The attributes each node may carry, read or named as lost where it is read. */
const NODE_ATTRIBUTES: Record<string, string[]> = {
  doc: [],
  paragraph: [],
  heading: ["level"],
  bulletList: [],
  orderedList: ["order"],
  listItem: [],
  taskList: [],
  taskItem: ["state"],
  blockTaskItem: ["state"],
  decisionList: [],
  decisionItem: ["state"],
  blockquote: [],
  rule: [],
  codeBlock: ["language", "uniqueId"],
  table: ["isNumberColumnEnabled", "layout", "width", "displayMode"],
  tableRow: [],
  tableHeader: ["colspan", "rowspan", "colwidth", "background"],
  tableCell: ["colspan", "rowspan", "colwidth", "background"],
  mediaSingle: ["layout", "width", "widthType"],
  mediaGroup: [],
  media: ["type", "id", "collection", "alt", "width", "height", "occurrenceKey", "url"],
  mediaInline: ["type", "id", "collection", "alt", "width", "height", "occurrenceKey"],
  caption: [],
  mention: ["id", "text", "accessLevel", "userType"],
  emoji: ["shortName", "id", "text"],
  inlineCard: ["url"],
  hardBreak: ["text"],
  text: [],
  date: ["timestamp"],
  status: ["text", "color", "style"],
  panel: ["panelType", "panelIcon", "panelIconId", "panelIconText", "panelColor"],
  expand: ["title"],
  nestedExpand: ["title"],
  blockCard: ["url", "datasource", "width", "layout"],
  embedCard: ["url", "layout", "width", "originalHeight", "originalWidth"],
};

/**
 * Names an attribute the node's kind does not know as "other formatting". An
 * element's `localId` only identifies it, so it changes nothing a reader sees.
 */
function noteAttributes(node: AdfNode) {
  const known = typeof node.type === "string" ? NODE_ATTRIBUTES[node.type] : undefined;
  if (!known) return;
  for (const name of Object.keys(node.attrs ?? {})) {
    if (name !== "localId" && !known.includes(name)) lose("other formatting");
  }
}

/** What each mark Markdown cannot hold is called when it is lost. */
const MARK_LOSSES: Record<string, string> = {
  textColor: "text colour",
  backgroundColor: "highlight",
  underline: "underline",
  annotation: "inline comments",
  alignment: "text alignment",
  indentation: "indentation",
  fontSize: "font size",
  breakout: "wide blocks",
  border: "image borders",
};

function loseMark(mark: AdfMark) {
  if (mark.type === "subsup") {
    lose(mark.attrs?.type === "sub" ? "subscript" : "superscript");
    return;
  }
  lose((typeof mark.type === "string" && MARK_LOSSES[mark.type]) || "other formatting");
}

/** A block's own marks, such as alignment, which Markdown has none of. */
function noteBlockMarks(node: AdfNode) {
  for (const mark of marksOf(node)) loseMark(mark);
}

/** A block as Markdown. A top-level empty line is kept in place by the write, so it loses nothing. */
function renderBlock(node: AdfNode, top = false): string {
  noteAttributes(node);
  if (!["mediaSingle", "table"].includes(String(node.type))) noteBlockMarks(node);
  switch (node.type) {
    case "paragraph":
      return renderParagraph(childrenOf(node), top);
    case "heading":
      return renderHeading(node);
    case "bulletList":
      return renderList(childrenOf(node), () => "- ");
    case "orderedList": {
      const order = attr(node, "order");
      const valid = typeof order === "number" && Number.isInteger(order) && order >= 0 && order < 1e9 - 1e6;
      if (order !== undefined && !valid) lose("other formatting");
      const start = valid ? order : 1;
      return renderList(childrenOf(node), (index) => `${start + index}. `);
    }
    case "taskList":
      return renderTaskList(node);
    case "decisionList":
      lose("decisions");
      return renderList(childrenOf(node), () => "- ");
    case "listItem":
    case "taskItem":
    case "decisionItem":
      return renderListItemBody(node);
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
      return renderQuote(childrenOf(node));
    case "panel":
      lose("panels");
      return renderQuote(childrenOf(node));
    case "rule":
      return "---";
    case "table":
      return renderTable(node);
    case "mediaSingle":
      return renderMediaSingle(node);
    case "mediaGroup":
      return childrenOf(node)
        .map((media) => {
          // Only Jira files come back as a group.
          if (attr(media, "type") === "external") lose("other formatting");
          return renderMedia(media, new URLSearchParams(), "group");
        })
        .join("\n");
    case "expand":
    case "nestedExpand": {
      lose("expand sections");
      const title = stringAttr(node, "title");
      const body = renderContainer(childrenOf(node));
      return title ? [`**${escapeText(title)}**`, body].filter(Boolean).join("\n\n") : body;
    }
    case "blockCard":
    case "embedCard": {
      lose("link previews");
      const url = stringAttr(node, "url");
      return url ? renderAutolink(url) : "";
    }
    case "extension":
    case "bodiedExtension":
    case "multiBodiedExtension":
    case "extensionFrame":
      lose("app content");
      return renderContainer(childrenOf(node));
    default:
      lose("other formatting");
      return isInlineType(node.type) ? renderParagraph([node]) : renderContainer(childrenOf(node));
  }
}

function isInlineType(type: unknown) {
  return [
    "text",
    "hardBreak",
    "mention",
    "emoji",
    "inlineCard",
    "date",
    "status",
    "mediaInline",
    "placeholder",
    "inlineExtension",
  ].includes(String(type));
}

/**
 * Blocks inside a quote or another container, set apart by a blank line.
 * Markdown has no empty paragraph between them, so one is lost.
 */
function renderContainer(nodes: AdfNode[], separator = (_previous: AdfNode, _next: AdfNode, _markdown: string) => "\n\n") {
  const rendered = nodes
    .map((node) => ({ node, markdown: renderBlock(node) }))
    .filter(({ markdown }) => markdown.trim().length > 0);
  if (rendered.length > 0 && rendered.length < nodes.length) lose("empty lines");
  return rendered
    .map(({ node, markdown }, index) =>
      index === 0 ? markdown : separator(rendered[index - 1]!.node, node, markdown) + markdown,
    )
    .join("");
}

function renderQuote(nodes: AdfNode[]) {
  return prefixLines(renderContainer(nodes), "> ") || ">";
}

function renderHeading(node: AdfNode) {
  const raw = attr(node, "level");
  const level = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 6 ? raw : 1;
  if (level !== raw) lose("other formatting");
  let text = renderInlines(childrenOf(node));
  if (text.includes("\n")) {
    lose("line breaks in headings");
    text = text.replace(/[ \t]*\n[ \t]*/g, " ");
  }
  if (/^[ \t]|[ \t]$/.test(text)) lose("spacing");
  text = text.replace(/^[ \t]+|[ \t]+$/g, "");
  // A run of # at the end would close the heading.
  text = text.replace(/(^|[^\\])(#+)$/, "$1\\$2");
  return text ? `${"#".repeat(level)} ${text}` : "#".repeat(level);
}

function renderParagraph(nodes: AdfNode[], top = false) {
  const lines = renderInlines(nodes).split("\n");
  // Lines past the last with text are empty lines Markdown cannot hold.
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === "") last -= 1;
  if (last === -1) {
    // Only hard breaks or spaces: an empty paragraph is all the write gives back.
    if (!top && lines.length > 1) lose("empty lines");
    if (!top && lines.some((line) => line.length > 0)) lose("spacing");
    return "";
  }
  if (last < lines.length - 1) lose("empty lines");
  return lines
    .slice(0, last + 1)
    .map((line) => {
      // Markdown drops spaces and tabs at a line's start and end.
      if (/^[ \t]|[ \t]$/.test(line)) lose("spacing");
      const text = escapeLineStart(line.replace(/^[ \t]+|[ \t]+$/g, ""));
      // An empty line between lines is a backslash, a hard break of its own.
      return text || "\\";
    })
    .join("\n");
}

function renderList(items: AdfNode[], marker: (index: number) => string): string {
  return items
    .map((item, index) => {
      if (item.type !== "listItem" && item.type !== "decisionItem") lose("other formatting");
      return renderItem(marker(index), renderListItemBody(item));
    })
    .join("\n");
}

function renderItem(prefix: string, body: string, indent = prefix.length) {
  return body ? prefix + indentContinuation(body, " ".repeat(indent)) : prefix.trimEnd();
}

function renderListItemBody(item: AdfNode): string {
  noteAttributes(item);
  const children = childrenOf(item);
  // Task and decision items hold inline content directly.
  if (children.every((child) => isInlineType(child.type))) {
    return renderParagraph(children);
  }
  return renderContainer(children, (previous, next, markdown) =>
    // A list or a code fence right under a paragraph stays in the item
    // without a blank line, as long as it can interrupt the paragraph.
    previous.type === "paragraph" && (next.type === "codeBlock" || interruptsParagraph(next, markdown))
      ? "\n"
      : "\n\n",
  );
}

/** Whether a rendered list may start right under a paragraph line. */
function interruptsParagraph(node: AdfNode, markdown: string) {
  if (!["bulletList", "orderedList", "taskList"].includes(String(node.type))) return false;
  const first = /^(?:-|(\d+)\.)[ \t]+\S/.exec(markdown);
  return Boolean(first && (first[1] === undefined || first[1] === "1"));
}

function renderTaskList(node: AdfNode): string {
  const lines: string[] = [];
  for (const child of childrenOf(node)) {
    if (child.type === "taskList") {
      const nested = renderTaskList(child);
      if (lines.length === 0) {
        lose("other formatting");
        lines.push(nested);
      } else {
        lines[lines.length - 1] += `\n${indentContinuation(nested, "  ", true)}`;
      }
      continue;
    }
    if (child.type !== "taskItem") lose("other formatting");
    noteAttributes(child);
    const marker = attr(child, "state") === "DONE" ? "- [x] " : "- [ ] ";
    // The item's content starts after "- ", its checkbox included.
    lines.push(renderItem(marker, renderListItemBody(child), 2));
  }
  return lines.join("\n");
}

function renderCodeBlock(node: AdfNode): string {
  const code = childrenOf(node)
    .map((child) => {
      if (child.type !== "text") lose("other formatting");
      if (marksOf(child).length > 0) lose("other formatting");
      return typeof child.text === "string" ? child.text : "";
    })
    .join("");
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  let language = attr(node, "language");
  if (typeof language !== "string" || /[\s`]/.test(language)) {
    if (language !== undefined && language !== null && language !== "") lose("other formatting");
    language = "";
  }
  return `${fence}${language}\n${code}\n${fence}`;
}

// Jira's default table: as wide as the text, laid out as the editor lays it.
const DEFAULT_TABLE_LAYOUTS = new Set([undefined, "default", "center"]);
const DEFAULT_TABLE_WIDTHS = new Set([undefined, 760]);

function renderTable(node: AdfNode): string {
  if (attr(node, "isNumberColumnEnabled") === true) lose("numbered table rows");
  if (
    !DEFAULT_TABLE_LAYOUTS.has(attr(node, "layout") as string | undefined) ||
    !DEFAULT_TABLE_WIDTHS.has(attr(node, "width") as number | undefined) ||
    ![undefined, "default"].includes(attr(node, "displayMode") as string | undefined)
  ) {
    lose("table width");
  }
  if (marksOf(node).length > 0) lose("other formatting");

  const rows = childrenOf(node).flatMap((row, rowIndex) => {
    if (row.type !== "tableRow") {
      lose("other formatting");
      return [];
    }
    noteAttributes(row);
    const cells = childrenOf(row).map((cell) => {
      // Markdown's only header cells are its first row.
      if ((cell.type === "tableHeader") !== (rowIndex === 0)) lose("table header cells");
      if (cell.type !== "tableHeader" && cell.type !== "tableCell") lose("other formatting");
      return renderCell(cell);
    });
    return cells.length > 0 ? [cells] : [];
  });
  const [header, ...body] = rows;
  if (!header) {
    return "";
  }

  const width = Math.max(...rows.map((row) => row.length));
  // Markdown fills a short row with empty cells.
  if (rows.some((row) => row.length !== width)) lose("other formatting");
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [
    line(header),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(line),
  ].join("\n");
}

function renderCell(cell: AdfNode) {
  noteAttributes(cell);
  for (const name of ["colspan", "rowspan"]) {
    const span = attr(cell, name);
    if (span !== undefined && span !== 1) lose("merged table cells");
  }
  if (attr(cell, "colwidth") !== undefined) lose("column widths");
  if (stringAttr(cell, "background")) lose("cell colours");

  const children = childrenOf(cell);
  let text: string;
  const wasInCell = inCell;
  inCell = true;
  try {
    if (children.length === 1 && children[0]!.type === "paragraph") {
      noteAttributes(children[0]!);
      noteBlockMarks(children[0]!);
      text = renderInlines(childrenOf(children[0]!));
    } else {
      if (children.length > 0) lose("blocks in table cells");
      text = children.map((child) => renderBlock(child)).filter(Boolean).join(" ");
    }
  } finally {
    inCell = wasInCell;
  }
  if (text.includes("\n")) {
    lose("line breaks in table cells");
    text = text.replace(/[ \t]*\n[ \t]*/g, " ");
  }
  if (/^[ \t]|[ \t]$/.test(text)) lose("spacing");
  // A pipe splits a cell, in code and addresses too, unless escaped.
  let escaped = "";
  for (const char of text.replace(/^[ \t]+|[ \t]+$/g, "")) {
    escaped += char === "|" && !isEscaped(escaped, escaped.length) ? "\\|" : char;
  }
  return escaped;
}

function renderMediaSingle(node: AdfNode): string {
  for (const mark of marksOf(node)) {
    if (mark.type === "link") lose("linked images");
    else loseMark(mark);
  }
  const params = new URLSearchParams();
  const layout = stringAttr(node, "layout");
  if (layout && layout !== "center") params.set("layout", layout);
  const width = attr(node, "width");
  if (typeof width === "number") params.set("size", String(width));
  else if (width !== undefined) lose("other formatting");
  const widthType = stringAttr(node, "widthType");
  if (widthType) params.set("sizeType", widthType);

  let image = "";
  for (const child of childrenOf(node)) {
    if (child.type === "media" && !image) image = renderMedia(child, params, "single");
    else if (child.type === "caption") lose("image captions");
    else lose("other formatting");
  }
  return image;
}

/** The URL of the attachment an image shows, found by its file name. */
function attachmentUrl(filename: string | undefined) {
  if (!filename || !Array.isArray(images.attachments)) return undefined;
  const matches = images.attachments.filter(
    (attachment): attachment is { content: string } =>
      isNode(attachment) &&
      (attachment as { filename?: unknown }).filename === filename &&
      typeof (attachment as { content?: unknown }).content === "string",
  );
  return matches.length === 1 ? matches[0]!.content : undefined;
}

/**
 * An image: its alt text, and an address that names its media, size and
 * place, so the write gives it back as it was.
 */
function renderMedia(media: AdfNode, container: URLSearchParams, kind: "single" | "group" | "inline"): string {
  noteAttributes(media);
  if (media.type !== "media" && media.type !== "mediaInline") {
    lose("other formatting");
    return "";
  }
  for (const mark of marksOf(media)) {
    if (mark.type === "link") lose("linked images");
    else loseMark(mark);
  }
  const alt = stringAttr(media, "alt");
  const params = new URLSearchParams();
  const type = stringAttr(media, "type");
  const external = media.type === "media" && type === "external";
  let base: string;
  if (external) {
    base = stringAttr(media, "url") ?? "";
  } else {
    base = attachmentUrl(alt) ?? images.issueUrl ?? "";
    params.set("id", stringAttr(media, "id") ?? "");
    params.set("collection", typeof attr(media, "collection") === "string" ? String(attr(media, "collection")) : "");
    if (type && (kind === "inline" || type !== "file")) params.set("type", type);
  }
  for (const name of ["width", "height"]) {
    const value = attr(media, name);
    if (typeof value === "number") params.set(name, String(value));
    else if (value !== undefined) lose("other formatting");
  }
  const occurrenceKey = stringAttr(media, "occurrenceKey");
  if (occurrenceKey) params.set("occurrenceKey", occurrenceKey);
  for (const [name, value] of container) params.set(name, value);
  // A web image comes back on its own, so it carries no group.
  if (kind !== "single" && !external) params.set(kind, "");

  const query = params.toString();
  const address = query ? `${base}${MEDIA_MARK}${query}` : base;
  return `![${escapeText(alt ?? "")}](${destination(address)})`;
}

type Emphasis = "strong" | "em" | "strike";

const EMPHASIS_MARKERS: Record<Emphasis, string> = { strong: "**", em: "*", strike: "~~" };

type LinkTarget = { href: string; title?: string };

type OpenMark = { kind: Emphasis } | { kind: "link"; target: LinkTarget };

type Run =
  | { kind: "text"; text: string; emphasis: Emphasis[]; link?: LinkTarget; code: boolean }
  | { kind: "atom"; markdown: string };

/** The runs of a paragraph's inline content, with what each is marked with. */
function toRuns(nodes: AdfNode[]): Run[] {
  return nodes.flatMap((node): Run[] => {
    noteAttributes(node);
    switch (node.type) {
      case "text":
        if (typeof node.text !== "string" || node.text.length === 0) return [];
        // A line break inside text would come back as a hard break.
        if (/[\r\n]/.test(node.text)) lose("other formatting");
        return [textRun(node.text.replace(/\r\n?/g, "\n"), marksOf(node))];
      case "hardBreak":
        return [{ kind: "atom", markdown: "\n" }];
      case "mention": {
        const id = stringAttr(node, "id") ?? "";
        const text = stringAttr(node, "text") ?? "";
        // The write gives a mention its name after an @, as Jira writes one.
        if (!/^@\S/.test(text) || !id || /\s/.test(id)) lose("other formatting");
        const name = text.replace(/^@/, "") || "someone";
        return [{ kind: "atom", markdown: `[@${escapeText(name)}](${destination(`mention:${id}`)})` }];
      }
      case "emoji": {
        const shortName = stringAttr(node, "shortName") ?? "";
        const text = stringAttr(node, "text");
        // A standard emoji reads as its character, a custom one as its name,
        // and the write gives either back as text, not as Jira's emoji.
        lose("emoji");
        return [{ kind: "atom", markdown: escapeText(text && text !== shortName ? text : shortName) }];
      }
      case "inlineCard": {
        const url = stringAttr(node, "url");
        if (!url) lose("link previews");
        return url ? [{ kind: "atom", markdown: renderAutolink(url) }] : [];
      }
      case "date": {
        lose("dates");
        const timestamp = Number(attr(node, "timestamp"));
        return Number.isFinite(timestamp)
          ? [{ kind: "atom", markdown: new Date(timestamp).toISOString().slice(0, 10) }]
          : [];
      }
      case "status":
        lose("status lozenges");
        return [{ kind: "atom", markdown: escapeText(stringAttr(node, "text") ?? "") }];
      case "mediaInline":
        return [{ kind: "atom", markdown: renderMedia(node, new URLSearchParams(), "inline") }];
      case "inlineExtension":
        lose("app content");
        return [];
      default:
        lose("other formatting");
        return typeof node.text === "string"
          ? [textRun(node.text, [])]
          : toRuns(childrenOf(node));
    }
  });
}

function textRun(text: string, marks: AdfMark[]): Run {
  const emphasis: Emphasis[] = [];
  let link: LinkTarget | undefined;
  let code = false;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
      case "em":
      case "strike":
        if (!emphasis.includes(mark.type)) emphasis.push(mark.type);
        break;
      case "code":
        code = true;
        break;
      case "link": {
        const href = mark.attrs?.href;
        const title = mark.attrs?.title;
        if (Object.keys(mark.attrs ?? {}).some((name) => name !== "href" && name !== "title")) {
          lose("other formatting");
        }
        if (typeof href === "string") {
          link = { href, ...(typeof title === "string" && title ? { title } : {}) };
        }
        break;
      }
      default:
        loseMark(mark);
    }
  }
  if (code && emphasis.length > 0) {
    // Jira allows no emphasis on code, and Markdown code keeps its text as written.
    lose("emphasis on code");
    emphasis.length = 0;
  }
  return { kind: "text", text, emphasis: emphasis.sort(byEmphasis), link, code };
}

const EMPHASIS_ORDER: Emphasis[] = ["strong", "em", "strike"];

function byEmphasis(left: Emphasis, right: Emphasis) {
  return EMPHASIS_ORDER.indexOf(left) - EMPHASIS_ORDER.indexOf(right);
}

function sameMark(left: OpenMark, right: OpenMark) {
  return left.kind === "link" && right.kind === "link"
    ? left.target.href === right.target.href && left.target.title === right.target.title
    : left.kind === right.kind;
}

function isPlainText(run: Run | undefined): run is Extract<Run, { kind: "text" }> {
  return run?.kind === "text" && !run.code;
}

/**
 * The marks each run should sit in. Emphasis on spaces alone, on code, which
 * Jira forbids, and around atoms such as mentions carries on only where the
 * text on both sides has it, so markers never open or close around nothing.
 */
function wantedMarks(runs: Run[]): OpenMark[][] {
  const wanted: OpenMark[][] = [];
  const nextText = (from: number) => runs.slice(from + 1).find((run) => isPlainText(run) && run.text.trim());
  runs.forEach((run, index) => {
    const previous = (wanted[index - 1] ?? []).filter((mark) => mark.kind !== "link");
    const next = nextText(index);
    const carried = previous.filter(
      (mark) => isPlainText(next) && next.emphasis.includes(mark.kind as Emphasis),
    );
    if (run.kind === "atom") {
      wanted.push(carried);
      return;
    }
    const link: OpenMark[] = run.link ? [{ kind: "link", target: run.link }] : [];
    if (run.code || !run.text.trim()) {
      const own = run.code ? [] : run.emphasis;
      const kept = carried.filter((mark) => run.code || own.includes(mark.kind as Emphasis));
      if (own.some((kind) => !kept.some((mark) => mark.kind === kind))) lose("formatting on spaces");
      wanted.push([...kept, ...link]);
      return;
    }
    wanted.push([...run.emphasis.map((kind): OpenMark => ({ kind })), ...link]);
  });
  return wanted;
}

/**
 * Inline content as Markdown. Marks open once across the runs they cover:
 * those that last longer open first, so emphasis and links nest. Spaces at
 * the edge of emphasis move outside its markers, which must touch text.
 */
function renderInlines(nodes: AdfNode[]): string {
  const runs = toRuns(nodes);
  const wanted = wantedMarks(runs);
  const stack: OpenMark[] = [];
  let out = "";

  const lasting = (mark: OpenMark, from: number) => {
    let count = 0;
    while (from + count < wanted.length && wanted[from + count]!.some((other) => sameMark(other, mark))) count += 1;
    return count;
  };
  const append = (markdown: string) => {
    // A `!` right before a link would make it an image.
    if (markdown.startsWith("[") && out.endsWith("!") && !isEscaped(out, out.length - 1)) {
      out = `${out.slice(0, -1)}\\!`;
    }
    out += markdown;
  };
  const closeTo = (depth: number) => {
    if (depth >= stack.length) return;
    const closesEmphasis = stack.slice(depth).some((mark) => mark.kind !== "link");
    const trailing = closesEmphasis ? /[ \t]*$/.exec(out)![0] : "";
    // Markers must touch text, so the spaces leave the emphasis.
    if (trailing) lose("formatting on spaces");
    out = out.slice(0, out.length - trailing.length);
    while (stack.length > depth) {
      const mark = stack.pop()!;
      out += mark.kind === "link" ? `](${destination(mark.target.href, mark.target.title)})` : EMPHASIS_MARKERS[mark.kind];
    }
    out += trailing;
  };

  runs.forEach((run, index) => {
    const marks = wanted[index]!;
    let keep = 0;
    while (keep < stack.length && marks.some((mark) => sameMark(mark, stack[keep]!))) keep += 1;
    closeTo(keep);
    const opening = marks
      .filter((mark) => !stack.some((open) => sameMark(open, mark)))
      .map((mark, order) => ({ mark, order, lasting: lasting(mark, index) }))
      // Longer marks outside; a link outside emphasis that ends with it.
      .sort(
        (left, right) =>
          right.lasting - left.lasting ||
          Number(right.mark.kind === "link") - Number(left.mark.kind === "link") ||
          left.order - right.order,
      )
      .map(({ mark }) => mark);

    let content = run.kind === "atom" ? run.markdown : run.code ? codeSpan(run.text) : escapeText(run.text);
    if (opening.some((mark) => mark.kind !== "link") && run.kind === "text" && !run.code) {
      const leading = /^[ \t]*/.exec(content)![0];
      if (leading) lose("formatting on spaces");
      out += leading;
      content = content.slice(leading.length);
    }
    for (const mark of opening) {
      append(mark.kind === "link" ? "[" : EMPHASIS_MARKERS[mark.kind]);
      stack.push(mark);
    }
    append(content);
  });
  closeTo(0);
  return out;
}

function codeSpan(raw: string) {
  let text = raw;
  // In a table, `\|` is how a pipe is written, in code too, so code that
  // holds a backslash before a pipe would come back without the backslash.
  if (inCell && text.includes("\\|")) lose("other formatting");
  if (text.includes("\n")) {
    lose("other formatting");
    text = text.replace(/\n/g, " ");
  }
  const fence = "`".repeat(longestRun(text, "`") + 1);
  // One space at each end is dropped when both have one, so keep it with another.
  const padding =
    text.startsWith("`") || text.endsWith("`") || (/^ [\s\S]* $/.test(text) && text.trim().length > 0) ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function renderAutolink(url: string) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>\u0000-\u001F]*$/.test(url)) {
    // As in code, an autolink in a table keeps no backslash before a pipe.
    if (inCell && url.includes("\\|")) lose("other formatting");
    return `<${url}>`;
  }
  lose("link previews");
  return `[${escapeText(url)}](${destination(url)})`;
}

/** A link's destination, and title, as Markdown reads them back exactly. */
function destination(url: string, title?: string) {
  let clean = url;
  if (/[\u0000-\u001F\u007F]/.test(clean)) {
    lose("other formatting");
    clean = clean.replace(/[\u0000-\u001F\u007F]/g, "");
  }
  // Spaces need angle brackets; without them, parentheses need escapes.
  const angle = clean === "" || clean.includes(" ");
  const escaped = escapeReferences(clean.replace(angle ? /[<>\\]/g : /[()<>\\]/g, "\\$&"));
  const dest = angle ? `<${escaped}>` : escaped;
  return title ? `${dest} "${escapeReferences(title.replace(/["\\]/g, "\\$&"))}"` : dest;
}

/** Escapes an `&` that would start a character reference. */
function escapeReferences(text: string) {
  return text.replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
}

function escapeText(text: string): string {
  return escapeReferences(text.replace(/[\\`*_[\]~|<]/g, "\\$&"));
}

/** Whether the character at `index` is escaped: an odd run of backslashes before it. */
function isEscaped(text: string, index: number) {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

// Text that starts a line with "#", ">", "-", "+", "1." or "1)", or a run of
// "-" or "=", would turn into a heading, quote, list or rule.
function escapeLineStart(line: string): string {
  return line.replace(
    /^(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|[-=](?=[-=\s]*$)|\d{1,9}(?=[.)](?:\s|$)))/,
    (token: string) => (/^\d/.test(token) ? `${token}\\` : `\\${token}`),
  );
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

function indentContinuation(text: string, indent: string, first = false): string {
  return text
    .split("\n")
    .map((line, index) => ((index === 0 && !first) || line.length === 0 ? line : `${indent}${line}`))
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
