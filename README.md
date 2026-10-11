# Ajour Connector - Jira

Ajour Connector - Jira syncs Jira issues into Ajour's local backlog and
supports estimate updates through Ajour's connector plugin protocol.

## Requirements

- Node.js 22
- Corepack with pnpm 10.7.0
- `just` (optional, but recommended)

## Development

```sh
just install
just test
just typecheck
just build
```

To rebuild the development plugin whenever its source changes, keep the watcher
running:

```sh
just dev
```

Run the complete local CI path with:

```sh
just verify
```

## Build an installable connector

```sh
just package
```

The archive is written to `package/jira-<version>.ajour-connector`. Its version
comes from `plugin.json`; keep that value aligned with `package.json` when
preparing a new release.

Every push to `main` runs tests and type checks, stamps a unique prerelease
version such as `1.0.0-main.3.9aac30e` into the build, packages the installable
archive, retains it as a GitHub Actions artifact for 30 days, and publishes it
as a GitHub prerelease. The base version remains the matching version declared
in `plugin.json` and `package.json` on the branch.

## Install in Ajour

In a production desktop build, open **Settings → Plugins**, choose **Install
plugin**, and select the generated `.ajour-connector` archive.

The connector requires the Jira site URL, account email, and an Atlassian API
token with the permissions appropriate for the enabled read or update
operations. Credentials stay in Ajour's local connector configuration.

## License

[MIT](LICENSE)
