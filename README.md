# Ajour Connector - Jira

Ajour Connector - Jira syncs Jira issues into Ajour's local backlog and
supports estimate updates through Ajour's connector plugin protocol.

The connector runs on **plugin API 4**: it runs in a sandboxed worker with no
network, disk or Node access. Every request goes through `ajour.http`, which
Ajour's broker sends for it. The broker builds the URL from the Site URL the
user saved and attaches the Basic credential from the email and the API token,
so the connector never sees the token.

## Requirements

- Node.js 24
- Corepack with pnpm 10.7.0
- `just` (optional, but recommended)

## Development

```sh
just install
just test
just typecheck
just build
```

`just build` bundles `src/plugin.ts` with esbuild into `dist/plugin.js`, one ES
module for the browser (`scripts/bundle-options.mjs`). `tsc` only type-checks,
and without Node types, so `Buffer` or `process` in the source fails the type
check. The bundle's tests also fail on a Node built-in, `Buffer`, `process`,
`require`, a global `fetch` or an `Authorization` header.

To rebuild the development plugin whenever its source changes, keep the watcher
running:

```sh
just dev
```

Run the complete local CI path with:

```sh
just verify
```

## The Ajour SDK

The tests use `createFakeAjour` from `@ajour/plugin-sdk`, which refuses what
Ajour's broker would: an endpoint, method or header that `plugin.json` does not
declare. The SDK is not on npm yet, so the packed package is vendored in
`vendor/ajour-plugin-sdk-0.1.0.tgz` and installed as a `file:` dev dependency.

It was built from Ajour commit `678911a6a6f935927a956087eb6b742120446a9f`
(`packages/plugin-sdk`, version 0.1.0). Refresh it when the plugin contract
changes:

```sh
# in an Ajour checkout
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @ajour/plugin-sdk build
cd packages/plugin-sdk && npm pack
# copy ajour-plugin-sdk-<version>.tgz to vendor/, point package.json at it,
# run `just install`, and update the commit above
```

Once the SDK is published, swap the `file:` dependency for a version range and
delete `vendor/`.

## Build an installable connector

```sh
just package
```

The archive is written to `package/jira-<version>.ajour-connector`. It holds
`plugin.json` and `dist/` (the bundle) only. Its version comes from
`plugin.json`; keep that value aligned with `package.json` when preparing a new
release.

Every push to `main` runs tests and type checks, stamps a unique prerelease
version such as `1.0.0-main.3.9aac30e` into the build, packages the installable
archive, retains it as a GitHub Actions artifact for 30 days, and publishes it
as a GitHub prerelease. The base version remains the matching version declared
in `plugin.json` and `package.json` on the branch.

## Descriptions

Each sync sends an issue's full description as `description`, beside the old
4,000-character `note` that Ajour versions before synced descriptions read
(Ajour's ADR 0009). Jira Cloud's REST API v3 holds descriptions in Atlassian
Document Format (ADF), which a dependency-free converter turns into Markdown:

- Headings, paragraphs and hard breaks, bold, italic, strikethrough, code,
  links with their titles, smart links (as `<url>`), quotes, rules, bullet,
  ordered and task lists, code blocks with their language, and tables with
  a header row become Markdown that writes back as the same ADF.
- Mentions become `[@Name](mention:<accountId>)`.
- Images stay Markdown images and never count as lost. Their address is the
  attachment's URL, found by file name, or the issue's, followed by
  `#ajour-media?id=…&collection=…` and the size, layout and grouping the write
  needs to rebuild the same media.
- What Markdown cannot hold is named in `lost`, never dropped silently: text
  colour, highlight, underline, superscript, subscript, inline comments, text
  alignment, indentation, font size, panels, expand sections, status
  lozenges, dates, emoji, decisions, link previews, wide blocks, app content,
  image captions, borders and links, table header cells outside the first
  row, merged cells, column widths, cell colours, table width, numbered rows,
  blocks and line breaks in table cells, line breaks in headings, spaces at a
  line's start or end ("spacing"), emphasis on spaces at its edges
  ("formatting on spaces"), empty lines inside a block, emphasis on code, and
  a backslash before a pipe in a table cell's code, which GFM tables cannot
  keep. Jira's default table width, 760, is not a loss.
  Any node, mark or attribute the converter does not know is "other
  formatting". A description whose Markdown would not write back as itself is
  "formatting Ajour cannot write back".
- A description longer than the 64,000 characters Ajour stores is cut, with
  `cut: true`.

`readDescription` returns an issue's current description the same way, with
one GET of its description and attachments.

`writeDescription` writes the user's edit back with Jira's issue edit
(`PUT /rest/api/3/issue/{key}`), which needs the Edit issues permission, or
`write:jira-work` for a scoped token:

- It reads the issue first. If its description, converted as a sync converts
  it, is no longer Ajour's `expected` text, it writes nothing and answers
  `conflict`. Jira's issue edit has no revision test, so this check runs one
  request before the write; a 409 "conflicting update" from Jira is answered
  as a conflict when the description moved. If the text is the same but now
  cut, it writes nothing; if it is lossy, it writes only when each loss is in
  the request's `allowedLoss`.
- Every top-level block the edit leaves alone keeps its ADF exactly, with the
  formatting Markdown cannot hold, ids included, where the user left it or
  moved it, and so do the empty paragraphs between blocks wherever the blank
  line there stayed. Only changed blocks are written from the Markdown, and a
  kept block that Markdown would read as one with the change joins it. A
  description of empty paragraphs only keeps them after the new text.
- The same holds inside a block the edit changed: its children are lined up
  with the source block's children by their Markdown, at every depth (table
  rows and cells, list and task items, quotes). A child that reads the same is
  the source child itself; a changed child keeps its ids and the attributes
  Markdown has no place for, and a mention, inline file or smart link in
  changed text keeps its source attributes.
- A check runs on the result that shares none of the patch's alignment, and
  conserves the source. It keys every node, at every depth, by its kind and
  its own Markdown, not by its ancestors, so a mention stays the same mention
  when its paragraph becomes a heading. A hard break is keyed by the lines on
  each side, an empty block by the nearest blocks with Markdown. For every
  key the written description still holds, every source node with that key
  must be written, deep-equal, ids and attributes included, matched outermost
  first; a key no longer held was changed or deleted by the user. A changed
  node may carry ids and attributes only from a source node of its kind that
  did not survive, and no id (`localId`, `uniqueId`) is written twice. A kept
  node written otherwise must lose only what the user allowed; anything else
  writes nothing.
- The write keeps each node that reads the same as a source node, wherever it
  now stands: a mention in a paragraph turned heading, list item or quote.
- A hard break or an empty paragraph has no Markdown of its own, so it is
  told by its boundaries, in the write and, separately, in the check. A hard
  break stays the break after its line, or before the next line, when that
  line is kept and still has a break on that side; an empty block likewise
  next to a kept block, and at the start or the end of its block. The rest
  pair in order when as many are left on each side. A break beside a kept
  line with no break left on its side was removed by the user, who split the
  paragraph there or joined its lines. Across paragraphs, list items and
  quotes the user split or joined, a break goes where a written break follows
  its line or leads its next line, and an empty block next to the block it
  followed or preceded, or at the same end of what its container became.
  A break with an id or attributes and neither of its lines kept cannot be
  placed, and nothing is written.
- Last, a backstop that pairs nothing: every source node with an id or
  attributes the writer would not give it must be written as it was, unless
  its own Markdown is gone; an empty block unless neither block beside it
  stands anywhere; a hard break unless no written break, other than a source
  break of its own, stands beside its lines.
- A mention, inline file or smart link is resolved by the line or the block
  that holds it before twins are judged, so two mentions of one person in
  different paragraphs never stand in each other's way.
- Nodes that read the same and differ only in their ids (`localId`,
  `uniqueId`) are twins no reader can tell apart: when some are deleted, the
  write keeps the earliest of them, in document order, each a real source
  node with its own id. Nodes that read the same but differ in anything else,
  such as a mention's `accessLevel`, are kept only where every optimal
  alignment agrees on which one stayed; when fewer of them are left than there
  were, which survived cannot be told, and nothing is written; the error says
  to edit in Jira.
- A child the user moved without changing it, inside a list or task list, is
  kept as it was; so is a mention left when another of the same person goes.
- Losses beyond the 20 names Ajour shows are checked too: such a description
  is never written.
- A description longer than Jira's 32,767 characters, measured as the ADF's
  JSON, is refused with the count. An empty text clears the description.

The manifest declares `description` with `write: true` and `maxLength: 32767`.

## Install in Ajour

In a production desktop build, open **Settings → Plugins**, choose **Install
plugin**, and select the generated `.ajour-connector` archive.

The connector requires the Jira site URL, account email, and an Atlassian API
token with the permissions appropriate for the enabled read or update
operations. Ajour keeps the token in its vault and never passes it to the
connector. The site must be Jira Cloud on a public address: the connector uses
REST API v3 and does not declare an on-premises connection.

Until the release that switches every plugin to API 4, Ajour admits an API 4
package in development builds only.

### What the connector may call

`plugin.json` declares these endpoints, relative to the Site URL, and the
`Accept` and `Content-Type` request headers. Ajour shows them in the plugin's
Access section, and its broker refuses anything else.

| Method | Path | Used for |
| ------ | ---- | -------- |
| GET | `/rest/api/3/myself` | Checking the credential when a connection is saved |
| GET | `/rest/api/3/field` | Resolving the estimate fields by name or id |
| POST | `/rest/api/3/search/jql` | The sync's JQL search |
| POST | `/rest/api/3/search` | The search's fallback when the site rejects the first |
| GET | `/rest/api/3/issue/*` | Reading an issue's status, priority, description and attachments |
| PUT | `/rest/api/3/issue/*` | Writing estimates, priority and descriptions |
| GET | `/rest/api/3/issue/*/transitions` | Listing the statuses an issue can move to |
| POST | `/rest/api/3/issue/*/transitions` | Settling an issue into a status |

The connector loads when needed (`runtime.start`).

## License

[MIT](LICENSE)
