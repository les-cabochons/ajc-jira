# Ajour Connector - Jira

Ajour Connector - Jira syncs Jira issues into HarDay's local backlog and
supports estimate updates through HarDay's connector plugin protocol.

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

Run the complete local CI path with:

```sh
just verify
```

## Build an installable connector

```sh
just package
```

The archive is written to `package/jira-<version>.harday-connector`. Its version
comes from `plugin.json`; keep that value aligned with `package.json` when
preparing a new release.

Every push to `main` runs tests and type checks, stamps a unique prerelease
version such as `1.0.0-main.3.9aac30e` into the build, packages the installable
archive, and retains it as a GitHub Actions artifact for 30 days. The base
version remains the matching version declared in `plugin.json` and
`package.json` on the branch.

## Install in HarDay

In a production desktop build, open **Settings → Plugins**, choose **Install
plugin**, and select the generated `.harday-connector` archive.

The connector requires the Jira site URL, account email, and an Atlassian API
token with the permissions appropriate for the enabled read or update
operations. Credentials stay in HarDay's local connector configuration.

## License

[MIT](LICENSE)
