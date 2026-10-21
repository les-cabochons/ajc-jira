// Converts the Markdown Ajour edits back to a Jira description in Atlassian
// Document Format (Ajour's ADR 0009). It reads the Markdown adf-markdown.ts
// writes, and the CommonMark people type: headings, paragraphs whose single
// line breaks stay hard breaks, lists and task lists, quotes, code, rules,
// tables, links, images, emphasis, strikethrough, autolinks and Ajour's
// mentions. Raw HTML is kept as text. A blank line ends a list, as
// adf-markdown.ts writes two lists apart, so ADF → Markdown → ADF → Markdown
// is stable. Blocks Jira does not allow where they stand, such as a heading in
// a quote, are written as paragraphs.

import { MEDIA_MARK } from "./adf-markdown.js";

export type AdfMarkNode = { type: string; attrs?: Record<string, unknown> };

export type AdfOutNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMarkNode[];
  content?: AdfOutNode[];
};

export type AdfDocument = { type: "doc"; version: 1; content: AdfOutNode[] };

type ListItem = { blocks: Block[]; task?: "TODO" | "DONE"; taskMarker?: string };

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "rule" }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; header: string[]; rows: string[][] };

/** Where blocks stand, which decides the blocks Jira allows. */
type Container = "doc" | "quote" | "item";

/** The ADF document of a Markdown description. */
export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return { type: "doc", version: 1, content: toAdf(parseBlocks(lines), "doc") };
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}|$)/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const TABLE_DIVIDER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

// A non-breaking space is text, as in CommonMark: only spaces and tabs are
// blank or indent.
function isBlank(line: string) {
  return /^[ \t]*$/.test(line);
}

function indentOf(line: string) {
  return line.length - line.replace(/^[ \t]+/, "").length;
}

function trimSpaces(text: string) {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Whether a line starts a block that ends a paragraph. */
function startsBlock(line: string) {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) {
    return true;
  }
  const item = LIST_ITEM.exec(line);
  // An ordered list breaks a paragraph only from 1, and no empty item does.
  return Boolean(
    item &&
      item[3] !== "" &&
      (!/^\d/.test(item[2]!) || Number.parseInt(item[2]!, 10) === 1),
  );
}

function isTableRow(line: string) {
  return line.replace(/^[ \t]+/, "").startsWith("|");
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      const marker = fence[2]!;
      const indent = fence[1]!.length;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          index += 1;
          break;
        }
        body.push(lines[index]!.replace(new RegExp(`^ {0,${indent}}`), ""));
        index += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n"), language: decodeText(trimSpaces(fence[3]!)).split(/[ \t]/)[0]! });
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (index < lines.length && (indentOf(lines[index]!) >= 4 || isBlank(lines[index]!))) {
        body.push(lines[index]!.slice(Math.min(4, indentOf(lines[index]!))));
        index += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
      blocks.push({ kind: "code", text: body.join("\n"), language: "" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        body.push(lines[index]!.replace(QUOTE, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(body) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      index = parseList(lines, index, blocks);
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!)) {
      const header = splitRow(line);
      if (splitRow(lines[index + 1]!).length === header.length) {
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && isTableRow(lines[index]!)) {
          rows.push(splitRow(lines[index]!));
          index += 1;
        }
        blocks.push({ kind: "table", header, rows });
        continue;
      }
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!)) {
      const next = lines[index]!;
      const setext = SETEXT.exec(next);
      if (setext) {
        blocks.push({
          kind: "heading",
          level: setext[1]![0] === "=" ? 1 : 2,
          text: paragraph.map(trimSpaces).join(" "),
        });
        paragraph.length = 0;
        index += 1;
        break;
      }
      if (startsBlock(next)) break;
      paragraph.push(next);
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

/**
 * Parses the list starting at `start`, and returns the index after it. A
 * blank line ends the list unless the item goes on indented below it.
 */
function parseList(lines: string[], start: number, blocks: Block[]): number {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = /^\d/.test(first[2]!);
  const delimiter = first[2]!.slice(-1);
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index]!);
    if (
      !item ||
      RULE.test(lines[index]!) ||
      /^\d/.test(item[2]!) !== ordered ||
      item[2]!.slice(-1) !== delimiter
    ) {
      break;
    }
    const content = item[1]!.length + item[2]!.length + (item[3] === "" ? 1 : item[3]!.length);
    let firstLine = lines[index]!.slice(Math.min(content, lines[index]!.length));
    const task = ordered ? null : TASK.exec(firstLine);
    if (task) firstLine = firstLine.slice(task[0].length);
    const body = [firstLine];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (isBlank(next)) {
        let following = index;
        while (following < lines.length && isBlank(lines[following]!)) following += 1;
        if (following < lines.length && indentOf(lines[following]!) >= content) {
          for (; index < following; index += 1) body.push("");
          continue;
        }
        break;
      }
      if (indentOf(next) >= content) {
        body.push(next.slice(content));
      } else if (LIST_ITEM.test(next) || startsBlock(next)) {
        break;
      } else {
        // A lazy line goes on the item's paragraph.
        body.push(next.replace(/^[ \t]+/, ""));
      }
      index += 1;
    }
    items.push({
      blocks: parseBlocks(body),
      ...(task ? { task: task[1] === " " ? "TODO" : "DONE", taskMarker: task[0] } : {}),
    });
  }
  blocks.push({
    kind: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2]!, 10) : 1,
    items,
  });
  return index;
}

/** A table row's cells, split on pipes that are not escaped. */
function splitRow(line: string): string[] {
  let text = trimSpaces(line);
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !isEscapedAt(text, text.length - 1)) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "|" && !isEscapedAt(text, at)) {
      cells.push(trimSpaces(cell));
      cell = "";
    } else {
      cell += text[at];
    }
  }
  cells.push(trimSpaces(cell));
  // An escaped pipe is a pipe, in code too, as GFM reads it.
  return cells.map((value) => value.replace(/\\\|/g, "|"));
}

function isEscapedAt(text: string, index: number) {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function toAdf(blocks: Block[], container: Container): AdfOutNode[] {
  return blocks.flatMap((block) => blockToAdf(block, container));
}

function blockToAdf(block: Block, container: Container): AdfOutNode[] {
  switch (block.kind) {
    case "paragraph":
      return paragraphToAdf(parseInline(paragraphText(block.lines)), container);
    case "heading": {
      const content = resolveImages(parseInline(trimSpaces(block.text)));
      // Jira allows headings only at the top.
      if (container !== "doc") return [withContent({ type: "paragraph" }, content)];
      return [withContent({ type: "heading", attrs: { level: block.level } }, content)];
    }
    case "code":
      return [
        {
          type: "codeBlock",
          ...(block.language ? { attrs: { language: block.language } } : {}),
          ...(block.text ? { content: [{ type: "text", text: block.text }] } : {}),
        },
      ];
    case "rule":
      return container === "doc" ? [{ type: "rule" }] : [{ type: "paragraph", content: [{ type: "text", text: "---" }] }];
    case "quote": {
      const content = toAdf(block.blocks, container === "item" ? "item" : "quote");
      // A quote holds no quote in Jira: a nested one joins it.
      if (container !== "doc") return content;
      return [{ type: "blockquote", content: content.length > 0 ? content : [{ type: "paragraph" }] }];
    }
    case "list":
      return [listToAdf(block)];
    case "table": {
      const width = block.header.length;
      const row = (cells: string[], type: string): AdfOutNode => ({
        type: "tableRow",
        content: Array.from({ length: width }, (_, index) => ({
          type,
          attrs: {},
          content: [withContent({ type: "paragraph" }, resolveImages(parseInline(cells[index] ?? "")))],
        })),
      });
      if (container !== "doc") {
        // Jira allows tables only at the top: their rows are written as lines.
        return [block.header, ...block.rows].map((cells) =>
          withContent({ type: "paragraph" }, resolveImages(parseInline(cells.join(" | ")))),
        );
      }
      return [
        {
          type: "table",
          attrs: { isNumberColumnEnabled: false, layout: "default" },
          content: [row(block.header, "tableHeader"), ...block.rows.map((cells) => row(cells, "tableCell"))],
        },
      ];
    }
  }
}

function withContent(node: AdfOutNode, content: AdfOutNode[]): AdfOutNode {
  return content.length > 0 ? { ...node, content } : node;
}

function listToAdf(list: Extract<Block, { kind: "list" }>): AdfOutNode {
  const tasks = taskListToAdf(list);
  if (tasks) return tasks;
  return {
    type: list.ordered ? "orderedList" : "bulletList",
    ...(list.ordered && list.start !== 1 ? { attrs: { order: list.start } } : {}),
    content: list.items.map((item) => {
      const blocks = item.taskMarker ? withTaskMarker(item) : item.blocks;
      const content = toAdf(blocks, "item");
      return { type: "listItem", content: content.length > 0 ? content : [{ type: "paragraph" }] };
    }),
  };
}

/** An item whose checkbox Jira cannot hold, with the checkbox as text again. */
function withTaskMarker(item: ListItem): Block[] {
  const [first, ...rest] = item.blocks;
  if (first?.kind === "paragraph") {
    return [{ kind: "paragraph", lines: [`${item.taskMarker}${first.lines[0]}`, ...first.lines.slice(1)] }, ...rest];
  }
  return [{ kind: "paragraph", lines: [item.taskMarker!.trimEnd()] }, ...item.blocks];
}

/**
 * A Jira task list, when every item has a checkbox and holds one paragraph,
 * with only task lists under it, which Jira keeps after their item.
 */
function taskListToAdf(list: Extract<Block, { kind: "list" }>): AdfOutNode | undefined {
  if (list.ordered || list.items.length === 0 || list.items.some((item) => !item.task)) return undefined;
  const content: AdfOutNode[] = [];
  for (const item of list.items) {
    const [first, ...rest] = item.blocks;
    const inline = first?.kind === "paragraph" ? resolveImages(parseInline(paragraphText(first.lines))) : [];
    const nested = (first?.kind === "paragraph" ? rest : item.blocks).map((block) =>
      block.kind === "list" ? taskListToAdf(block) : undefined,
    );
    if (nested.some((node) => !node)) return undefined;
    content.push(
      withContent({ type: "taskItem", attrs: { localId: newLocalId(), state: item.task! } }, inline),
      ...(nested as AdfOutNode[]),
    );
  }
  return { type: "taskList", attrs: { localId: newLocalId() }, content };
}

function newLocalId() {
  return crypto.randomUUID();
}

/**
 * A paragraph's lines as one text whose line breaks are hard breaks. Two
 * trailing spaces or a backslash mark a hard break, which every break already is.
 */
function paragraphText(lines: string[]) {
  return lines
    .map((line, index) => {
      const text = trimSpaces(line);
      // Only a backslash a line break follows is a hard break.
      const hardBreak = index < lines.length - 1 && text.endsWith("\\") && !isEscapedAt(text, text.length - 1);
      return hardBreak ? text.slice(0, -1) : text;
    })
    .join("\n");
}

/**
 * A paragraph, or the images it holds alone: each its own image, and those a
 * group held, as file cards together.
 */
function paragraphToAdf(nodes: AdfOutNode[], container: Container): AdfOutNode[] {
  const isSpace = (node: AdfOutNode) =>
    node.type === "hardBreak" || (node.type === "text" && !node.marks && !node.text!.trim());
  const blocks = nodes.filter((node) => !isSpace(node));
  // An image on the web with an address the link policy refuses is no media:
  // the paragraph is written as text, as the same image inline would be.
  const alone =
    blocks.length > 0 &&
    blocks.every((node) => {
      if (node.type !== IMAGE) return false;
      const { base, params } = imageParams(node);
      return !params.has("inline") && (params.has("id") || isSafeUrl(base));
    });
  if (!alone) return [withContent({ type: "paragraph" }, resolveImages(nodes))];

  const out: AdfOutNode[] = [];
  for (const image of blocks) {
    const { params } = imageParams(image);
    const media = mediaOf(image);
    if (params.has("group") && media.attrs!.type !== "external" && container !== "item") {
      const previous = out[out.length - 1];
      if (previous?.type === "mediaGroup") previous.content!.push(media);
      else out.push({ type: "mediaGroup", content: [media] });
      continue;
    }
    const attrs: Record<string, unknown> = { layout: params.get("layout") || "center" };
    const size = numberParam(params, "size");
    if (size !== undefined) attrs.width = size;
    const sizeType = params.get("sizeType");
    if (sizeType) attrs.widthType = sizeType;
    out.push({ type: "mediaSingle", attrs, content: [media] });
  }
  return out;
}

/** An image the inline parser found, before it becomes media. */
const IMAGE = "ajour-image";

function imageParams(image: AdfOutNode) {
  const url = String(image.attrs!.url);
  const mark = url.lastIndexOf(MEDIA_MARK);
  return mark === -1
    ? { base: url, params: new URLSearchParams() }
    : { base: url.slice(0, mark), params: new URLSearchParams(url.slice(mark + MEDIA_MARK.length)) };
}

function numberParam(params: URLSearchParams, name: string) {
  const value = params.get(name);
  if (value === null || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** The media an image's address names: a Jira file, or an image on the web. */
function mediaOf(image: AdfOutNode): AdfOutNode {
  const { base, params } = imageParams(image);
  const alt = String(image.attrs!.alt);
  const attrs: Record<string, unknown> = params.has("id")
    ? { type: params.get("type") || "file", id: params.get("id"), collection: params.get("collection") ?? "" }
    : { type: "external", url: base };
  if (alt) attrs.alt = alt;
  for (const name of ["width", "height"]) {
    const value = numberParam(params, name);
    if (value !== undefined) attrs[name] = value;
  }
  const occurrenceKey = params.get("occurrenceKey");
  if (occurrenceKey && params.has("id")) attrs.occurrenceKey = occurrenceKey;
  return { type: "media", attrs };
}

/**
 * Images inside text: a Jira file is inline media, and an image on the web,
 * which Jira cannot show inline, a link to it.
 */
function resolveImages(nodes: AdfOutNode[]): AdfOutNode[] {
  return mergeText(
    nodes.map((node) => {
      if (node.type !== IMAGE) return node;
      const { base, params } = imageParams(node);
      const alt = String(node.attrs!.alt);
      if (!params.has("id")) {
        const text = alt || base;
        return isSafeUrl(base)
          ? { type: "text", text, marks: [{ type: "link", attrs: { href: base } }] }
          : { type: "text", text };
      }
      const attrs: Record<string, unknown> = { id: params.get("id"), collection: params.get("collection") ?? "" };
      const type = params.get("type");
      if (type) attrs.type = type;
      if (alt) attrs.alt = alt;
      for (const name of ["width", "height"]) {
        const value = numberParam(params, name);
        if (value !== undefined) attrs[name] = value;
      }
      const occurrenceKey = params.get("occurrenceKey");
      if (occurrenceKey) attrs.occurrenceKey = occurrenceKey;
      return { type: "mediaInline", attrs };
    }),
  );
}

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** A named or numeric character reference, as CommonMark reads one. */
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/** The named references decoded; any other is kept as written. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntity(entity: string): string {
  const name = entity.slice(1, -1);
  if (name.startsWith("#")) {
    const code = /^#[xX]/.test(name) ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  }
  return NAMED_ENTITIES[name] ?? entity;
}

/** Text with its escapes and character references read, in one pass as CommonMark does. */
function decodeText(text: string) {
  return text.replace(
    /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match, escaped: string | undefined) => escaped ?? decodeEntity(match),
  );
}

/** Whether an address is web, mail, phone, file transfer or relative, never a script or data. */
function isSafeUrl(url: string) {
  // A browser drops control characters, and tabs and newlines anywhere, before
  // it reads the scheme, so any of them could hide one.
  if (/[\u0000-\u001F\u007F]/.test(url)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url.trim())?.[1]?.toLowerCase();
  return scheme === undefined || ["http", "https", "mailto", "tel", "ftp", "sftp"].includes(scheme);
}

type Emphasis = "strong" | "em" | "strike";

type Inline =
  | { kind: "text"; text: string }
  | { kind: "node"; node: AdfOutNode }
  | {
      kind: "delimiter";
      char: "*" | "_" | "~";
      count: number;
      canOpen: boolean;
      canClose: boolean;
      opens: Emphasis[];
      closes: Emphasis[];
    };

/** Inline Markdown as ADF inline nodes: escapes, code, links, images, mentions and emphasis. */
function parseInline(text: string): AdfOutNode[] {
  const tokens: Inline[] = [];
  const brackets = matchBrackets(text);
  const pushText = (value: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") last.text += value;
    else tokens.push({ kind: "text", text: value });
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at]!;

    if (char === "\n") {
      tokens.push({ kind: "node", node: { type: "hardBreak" } });
      at += 1;
      continue;
    }

    if (char === "&") {
      const entity = ENTITY.exec(text.slice(at, at + 40));
      if (entity) {
        pushText(decodeEntity(entity[0]));
        at += entity[0].length;
        continue;
      }
    }

    if (char === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1]!)) {
      pushText(text[at + 1]!);
      at += 2;
      continue;
    }

    if (char === "`") {
      const run = /^`+/.exec(text.slice(at, at + 1000))![0];
      const close = findCodeClose(text, at + run.length, run.length);
      if (close === -1) {
        pushText(run);
        at += run.length;
        continue;
      }
      let code = text.slice(at + run.length, close).replace(/\n/g, " ");
      if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0) {
        code = code.slice(1, -1);
      }
      tokens.push({ kind: "node", node: { type: "text", text: code, marks: [{ type: "code" }] } });
      at = close + run.length;
      continue;
    }

    if (char === "!" && text[at + 1] === "[") {
      const link = parseLink(text, at + 1, brackets);
      if (link) {
        tokens.push({ kind: "node", node: { type: IMAGE, attrs: { alt: decodeText(link.label), url: link.url } } });
        at = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLink(text, at, brackets);
      if (link) {
        const mention = /^mention:(\S+)$/.exec(link.url);
        if (mention && link.label.startsWith("@")) {
          tokens.push({ kind: "node", node: { type: "mention", attrs: { id: mention[1]!, text: decodeText(link.label) } } });
        } else {
          const label = parseInline(link.label);
          // A link to a script or other unsafe address keeps only its text.
          const mark: AdfMarkNode | undefined = isSafeUrl(link.url)
            ? { type: "link", attrs: { href: link.url, ...(link.title !== undefined ? { title: link.title } : {}) } }
            : undefined;
          for (const node of label) {
            tokens.push({ kind: "node", node: mark && node.type === "text" ? addMarks(node, [mark]) : node });
          }
        }
        at = link.end;
        continue;
      }
    }

    if (char === "<") {
      const autolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(text.slice(at));
      if (autolink && isSafeUrl(autolink[1]!)) {
        tokens.push({ kind: "node", node: { type: "inlineCard", attrs: { url: autolink[1]! } } });
        at += autolink[0].length;
        continue;
      }
      const email = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(
        text.slice(at),
      );
      if (email) {
        tokens.push({
          kind: "node",
          node: { type: "text", text: email[1]!, marks: [{ type: "link", attrs: { href: `mailto:${email[1]}` } }] },
        });
        at += email[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const run = new RegExp(`^\\${char}+`).exec(text.slice(at))![0];
      if (char === "~" && run.length > 2) {
        pushText(run);
        at += run.length;
        continue;
      }
      const before = at === 0 ? " " : text[at - 1]!;
      const after = at + run.length >= text.length ? " " : text[at + run.length]!;
      const leftFlanking =
        !/\s/.test(after) && (!isPunctuation(after) || /\s/.test(before) || isPunctuation(before));
      const rightFlanking =
        !/\s/.test(before) && (!isPunctuation(before) || /\s/.test(after) || isPunctuation(after));
      const canOpen =
        char === "_" ? leftFlanking && (!rightFlanking || isPunctuation(before)) : leftFlanking;
      const canClose =
        char === "_" ? rightFlanking && (!leftFlanking || isPunctuation(after)) : rightFlanking;
      tokens.push({ kind: "delimiter", char, count: run.length, canOpen, canClose, opens: [], closes: [] });
      at += run.length;
      continue;
    }

    pushText(char);
    at += 1;
  }

  resolveEmphasis(tokens);
  return buildInline(tokens);
}

function isPunctuation(char: string) {
  return /[\p{P}\p{S}]/u.test(char);
}

/** The index of the backtick run of `length` that closes a code span, or -1. */
function findCodeClose(text: string, from: number, length: number) {
  const pattern = /`+/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0].length === length) return match.index;
  }
  return -1;
}

/**
 * Each `[` and the `]` that closes it, found in one pass: escapes and code
 * spans hold no brackets, and an unclosed `[` closes nothing.
 */
function matchBrackets(text: string) {
  const matches = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "`") {
      const run = /^`+/.exec(text.slice(at, at + 1000))![0];
      const end = findCodeClose(text, at + run.length, run.length);
      at = end === -1 ? at + run.length - 1 : end + run.length - 1;
    } else if (char === "[") {
      open.push(at);
    } else if (char === "]" && open.length > 0) {
      matches.set(open.pop()!, at);
    }
  }
  return matches;
}

/** A link or image at `[`: its label, its address, its title and where it ends. */
function parseLink(text: string, open: number, brackets: Map<number, number>) {
  const close = brackets.get(open) ?? -1;
  if (close === -1 || text[close + 1] !== "(") return undefined;
  const destination = parseDestination(text, close + 2);
  if (!destination) return undefined;
  return {
    label: text.slice(open + 1, close),
    url: decodeText(destination.url),
    title: destination.title === undefined ? undefined : decodeText(destination.title),
    end: destination.end,
  };
}

/**
 * A link's destination and optional title from `from`, just after its `(`,
 * as CommonMark reads them: in angle brackets, or up to a space with escapes
 * and balanced parentheses. Undefined when no `)` closes it.
 */
function parseDestination(text: string, from: number) {
  let at = from;
  const skipSpaces = () => {
    while (at < text.length && /[ \t\n]/.test(text[at]!)) at += 1;
  };
  skipSpaces();
  let url = "";
  if (text[at] === "<") {
    at += 1;
    while (at < text.length && text[at] !== ">") {
      if (text[at] === "\n" || text[at] === "<") return undefined;
      if (text[at] === "\\" && at + 1 < text.length) {
        url += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      url += text[at];
      at += 1;
    }
    if (text[at] !== ">") return undefined;
    at += 1;
  } else {
    let depth = 0;
    while (at < text.length) {
      const char = text[at]!;
      if (char === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1]!)) {
        url += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      if (/[\s\u0000-\u001F]/.test(char)) break;
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      url += char;
      at += 1;
    }
    if (depth !== 0) return undefined;
  }
  skipSpaces();
  let title: string | undefined;
  const quoted = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^()\\]|\\.)*)\))/s.exec(text.slice(at));
  if (quoted && /[ \t\n]/.test(text[at - 1] ?? "")) {
    title = quoted[1] ?? quoted[2] ?? quoted[3] ?? "";
    at += quoted[0].length;
    skipSpaces();
  }
  if (text[at] !== ")") return undefined;
  return { url, title, end: at + 1 };
}

/**
 * Pairs emphasis delimiters, CommonMark's way. Open delimiters wait on a
 * stack, and a closer that finds no opener marks where later closers of its
 * kind stop looking, so pairing takes linear time. Strikethrough pairs runs
 * of the same length, as GFM does.
 */
function resolveEmphasis(tokens: Inline[]) {
  type Delimiter = Extract<Inline, { kind: "delimiter" }>;
  const openers: number[] = [];
  const bottoms = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const close = tokens[index]!;
    if (close.kind !== "delimiter") continue;
    if (close.canClose) {
      const kind = `${close.char}${close.canOpen ? 1 : 0}${close.count % 3}${close.char === "~" ? close.count : ""}`;
      const bottom = bottoms.get(kind) ?? -1;
      let at = openers.length - 1;
      while (close.count > 0 && at >= 0 && openers[at]! > bottom) {
        const open = tokens[openers[at]!] as Delimiter;
        // A run that can both open and close pairs only when the sum is not
        // a multiple of three, unless both are.
        if (
          open.char !== close.char ||
          (close.char === "~" && open.count !== close.count) ||
          (close.char !== "~" &&
            (open.canClose || close.canOpen) &&
            (open.count + close.count) % 3 === 0 &&
            !(open.count % 3 === 0 && close.count % 3 === 0))
        ) {
          at -= 1;
          continue;
        }
        const used = close.char === "~" ? close.count : open.count >= 2 && close.count >= 2 ? 2 : 1;
        const mark: Emphasis = close.char === "~" ? "strike" : used === 2 ? "strong" : "em";
        open.count -= used;
        close.count -= used;
        open.opens.unshift(mark);
        close.closes.push(mark);
        // Delimiters between the pair can no longer open across it.
        openers.length = open.count > 0 ? at + 1 : at;
        at = openers.length - 1;
      }
      if (close.count > 0) bottoms.set(kind, index - 1);
    }
    if (close.canOpen && close.count > 0) openers.push(index);
  }
}

const MARK_ORDER = ["strong", "em", "strike", "code", "link"];

function addMarks(node: AdfOutNode, marks: AdfMarkNode[]): AdfOutNode {
  const all = [...(node.marks ?? [])];
  const code = all.some((mark) => mark.type === "code");
  for (const mark of marks) {
    // Jira allows no emphasis on code.
    if (code && mark.type !== "link") continue;
    if (!all.some((existing) => existing.type === mark.type)) all.push(mark);
  }
  all.sort((left, right) => MARK_ORDER.indexOf(left.type) - MARK_ORDER.indexOf(right.type));
  return all.length > 0 ? { ...node, marks: all } : { ...node };
}

/** The ADF of paired tokens: text takes the emphasis open around it. */
function buildInline(tokens: Inline[]): AdfOutNode[] {
  const open = new Map<Emphasis, number>();
  const nodes: AdfOutNode[] = [];
  const active = (): AdfMarkNode[] =>
    (["strong", "em", "strike"] as Emphasis[]).filter((mark) => (open.get(mark) ?? 0) > 0).map((type) => ({ type }));
  const pushText = (value: string) => {
    if (value) nodes.push(addMarks({ type: "text", text: value }, active()));
  };
  for (const token of tokens) {
    if (token.kind === "text") {
      pushText(token.text);
    } else if (token.kind === "node") {
      nodes.push(token.node.type === "text" ? addMarks(token.node, active()) : token.node);
    } else {
      for (const mark of token.closes) open.set(mark, (open.get(mark) ?? 0) - 1);
      pushText(token.char.repeat(token.count));
      for (const mark of token.opens) open.set(mark, (open.get(mark) ?? 0) + 1);
    }
  }
  return mergeText(nodes);
}

/** Joins text nodes side by side that carry the same marks. */
function mergeText(nodes: AdfOutNode[]): AdfOutNode[] {
  const merged: AdfOutNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (
      previous?.type === "text" &&
      node.type === "text" &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      merged[merged.length - 1] = { ...previous, text: previous.text! + node.text! };
    } else {
      merged.push(node);
    }
  }
  return merged;
}
