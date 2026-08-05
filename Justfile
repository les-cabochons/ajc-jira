# Jira connector command surface

set quiet
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

PNPM := "corepack pnpm"

[private]
default: help

[doc("Displays available commands")]
help:
    just --list --unsorted

[doc("Installs dependencies from the lockfile")]
install:
    corepack enable
    {{PNPM}} install

[doc("Runs the connector tests")]
test:
    {{PNPM}} test

[doc("Runs TypeScript checks")]
typecheck:
    {{PNPM}} typecheck

[doc("Builds the connector JavaScript")]
build:
    {{PNPM}} build

[doc("Builds the installable .harday-connector archive")]
package:
    {{PNPM}} package

[doc("Runs the complete local CI verification")]
verify:
    {{PNPM}} verify
