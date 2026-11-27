# Cleaner catalog

Each operation folder holds one cleaner file per app and registers its
cleaners in its `index.ts`. [`index.ts`](../../src/cleaners/index.ts) combines
the folders into the catalog. Each cleaner declares a unique ID, the app it
belongs to for running-app checks, and a cleanup category chosen by what its
data is. An app can have a cleaner in more than one folder. To add a cleaner,
add its file to the folder and list it in that folder's `index.ts`.

Filesystem cleaners share the base removal method. Cleaners with release or
driver rules perform additional checks before removal.

## Shared

| File                                                    | Responsibility                                                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`base-cleaner.ts`](../../src/cleaners/base-cleaner.ts) | Implements common filesystem removal.                                                                                                          |
| [`helpers.ts`](../../src/cleaners/helpers.ts)           | Detects named and Chromium caches, updater downloads for installed updates, and old Squirrel versions. Resolves the Codex home and Scoop root. |

## General cache cleanup: [`cache/`](../../src/cleaners/cache/)

| File                                                                              | Responsibility                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`codex-cleaner.ts`](../../src/cleaners/cache/codex-cleaner.ts)                   | Finds regenerable Codex metadata and plugin catalog caches.                  |
| [`claude-code-cleaner.ts`](../../src/cleaners/cache/claude-code-cleaner.ts)       | Finds the regenerable Claude Code cache.                                     |
| [`claude-desktop-cleaner.ts`](../../src/cleaners/cache/claude-desktop-cleaner.ts) | Finds Chromium caches in the verified Claude Desktop package profile.        |
| [`discord-cleaner.ts`](../../src/cleaners/cache/discord-cleaner.ts)               | Finds Chromium caches in the Discord profile.                                |
| [`github-desktop-cleaner.ts`](../../src/cleaners/cache/github-desktop-cleaner.ts) | Finds Chromium caches in the GitHub Desktop profile.                         |
| [`vscode-cleaner.ts`](../../src/cleaners/cache/vscode-cleaner.ts)                 | Finds VS Code runtime and Chromium caches and downloaded extension archives. |

## Destructive cache cleanup: [`package-cache/`](../../src/cleaners/package-cache/)

Each package cache states its redownload and offline-use implications.

| File                                                                              | Responsibility                                                                                                   |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`npm-cleaner.ts`](../../src/cleaners/package-cache/npm-cleaner.ts)               | Finds npm's content-addressed download cache. Preserves `_npx` installs.                                         |
| [`bun-cleaner.ts`](../../src/cleaners/package-cache/bun-cleaner.ts)               | Finds downloaded Bun package versions in the per-user cache. Packages hard-linked into projects are not offered. |
| [`scoop-cleaner.ts`](../../src/cleaners/package-cache/scoop-cleaner.ts)           | Finds downloaded archives in a verified per-user Scoop cache. Skips in-progress downloads.                       |
| [`chocolatey-cleaner.ts`](../../src/cleaners/package-cache/chocolatey-cleaner.ts) | Finds the per-user `%TEMP%\chocolatey` download cache when Chocolatey's `cacheLocation` setting is the default.  |
| [`nuget-cleaner.ts`](../../src/cleaners/package-cache/nuget-cleaner.ts)           | Finds NuGet's download and HTTP caches. Preserves the global packages folder that projects use.                  |

## Old data and installations: [`installations/`](../../src/cleaners/installations/)

Updater cleaners offer payloads for installed updates only. Pending updates
are preserved.

| File                                                                                      | Responsibility                                                                                                                                |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`codex-cleaner.ts`](../../src/cleaners/installations/codex-cleaner.ts)                   | Finds superseded Codex releases and npm update residue, and delegates verification.                                                           |
| [`codex-installations.ts`](../../src/cleaners/installations/codex-installations.ts)       | Detects inactive releases and interrupted npm update residue. It checks running binaries and holds the installer lock during release removal. |
| [`codex-release-store.ts`](../../src/cleaners/installations/codex-release-store.ts)       | Verifies manifests and release selections per store. Keeps the selected and staged releases; a recorded previous release qualifies.           |
| [`claude-code-cleaner.ts`](../../src/cleaners/installations/claude-code-cleaner.ts)       | Finds superseded native Claude Code binaries and rechecks the current version before removal.                                                 |
| [`github-desktop-cleaner.ts`](../../src/cleaners/installations/github-desktop-cleaner.ts) | Finds old GitHub Desktop Squirrel versions and downloads.                                                                                     |
| [`discord-cleaner.ts`](../../src/cleaners/installations/discord-cleaner.ts)               | Finds old Discord Squirrel versions and update remnants.                                                                                      |
| [`slack-cleaner.ts`](../../src/cleaners/installations/slack-cleaner.ts)                   | Finds old Slack Squirrel versions and update remnants.                                                                                        |
| [`signal-rgb-cleaner.ts`](../../src/cleaners/installations/signal-rgb-cleaner.ts)         | Finds old SignalRGB and VortxEngine versions and update payloads.                                                                             |
| [`balena-etcher-cleaner.ts`](../../src/cleaners/installations/balena-etcher-cleaner.ts)   | Finds obsolete balenaEtcher Squirrel versions and updater payloads.                                                                           |
| [`t3-code-cleaner.ts`](../../src/cleaners/installations/t3-code-cleaner.ts)               | Finds downloaded T3 Code installers for installed updates.                                                                                    |
| [`opencode-cleaner.ts`](../../src/cleaners/installations/opencode-cleaner.ts)             | Finds verified OpenCode Desktop installer payloads and rechecks updater metadata before removal.                                              |
| [`obsidian-cleaner.ts`](../../src/cleaners/installations/obsidian-cleaner.ts)             | Finds Obsidian self-update installers.                                                                                                        |
| [`notion-cleaner.ts`](../../src/cleaners/installations/notion-cleaner.ts)                 | Finds downloaded Notion installers for installed updates.                                                                                     |
| [`chatbox-cleaner.ts`](../../src/cleaners/installations/chatbox-cleaner.ts)               | Finds installers in the Chatbox self-update cache.                                                                                            |
| [`vortex-cleaner.ts`](../../src/cleaners/installations/vortex-cleaner.ts)                 | Finds Vortex downloads in current and abandoned updater caches.                                                                               |
| [`linua-cleaner.ts`](../../src/cleaners/installations/linua-cleaner.ts)                   | Checks known Linua updater locations for installers.                                                                                          |
| [`nvidia-driver-cleaner.ts`](../../src/cleaners/installations/nvidia-driver-cleaner.ts)   | Finds downloaded and extracted installers and manages verified inactive display driver packages through Windows.                              |
| [`nvidia-driver-packages.ts`](../../src/cleaners/installations/nvidia-driver-packages.ts) | Parses Driver Store output and identifies inactive packages older than the active display drivers.                                            |
| [`amd-installer-cleaner.ts`](../../src/cleaners/installations/amd-installer-cleaner.ts)   | Finds known AMD chipset installer extractions.                                                                                                |
