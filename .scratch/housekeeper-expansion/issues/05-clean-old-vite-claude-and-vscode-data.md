# 05: Clean verified old Vite+, Claude Code, and VS Code data

Status: resolved
Type: task
Blocked by: 02

## What to build

Add per-user obsolete Vite+ releases, native Claude Code versions, and obsolete VS Code extensions to the old-installation operation.

## Acceptance criteria

- [x] Verify Vite+'s active release and any recorded fallback, and preserve both.
- [x] Identify the active native Claude Code version using the native installation, even if a different launcher comes first on `PATH`. Only verified superseded native versions qualify.
- [x] Offer VS Code extension directories only when the app's metadata explicitly identifies them as obsolete. Preserve installed extensions that remain in use.
- [x] Revalidate the metadata before removal and demonstrate each candidate type and each protected version in a dry run or disposable fixture.

## Comments

### Answer

- **Vite+** (`vite-plus-releases`): the selected release is the `current` junction in the data directory. The recorded fallback is `.previous-version`. Both are preserved, as are newer releases. The data directory follows Vite+'s own resolution: `VP_HOME`, else `~.vite-plus` when it holds a `current` link, else the `VP_DATA_DIR` group when all three `VP_*_DIR` variables are set, else `%LOCALAPPDATA%ite-plusdata`. `+force.<pid>.<nanos>` reinstall directories count as releases. An unparseable fallback marker disables the cleaner. Releases are pnpm installs, so a release contains junctions and hardlinked files. The candidate opts into `unlinkTreeLinks`, which unlinks those entries without following them (ADR 0003). Detection and removal skip while Vite+'s `.install.lock` is held. The layout was checked against the Vite+ docs and upstream source cited in the PR review. It was not checked against a real installation, because none exists on the development machine.
- **Claude Code** (`claude-code-versions`, already existed): the active version now comes from the native launcher `~\.local\bin\claude.exe` (run by absolute path), never `claude` on `PATH`. Only versions older than the active one qualify, and versions in use are skipped. A launcher that is a link is not trusted. The cleaner now checks running binaries by path (`manualRunningAppCheck = false`) instead of blocking whenever any Claude process runs, because Claude Code is usually running during a manual cleanup. A Claude process whose path cannot be read, such as an elevated one, blocks the check.
- **VS Code** (`vscode-extensions`): only `~\.vscode\extensions\.obsolete` entries marked `true` qualify, and any folder still listed in `extensions.json` is preserved. Both files must parse or nothing is offered. The default registry and every `%APPDATA%CodeUserprofiles<id>extensions.json` are consulted, and metadata files up to 4 MiB are read. The VS Code app-level running check still applies. Only the stable `.vscode` directory is covered, not Insiders or forks.
- The shared helper `running-paths.ts` lists running process paths, and the Codex cleaner now uses it too. Metadata is revalidated at removal for all three cleaners. Tests cover each candidate type and each protected version using sandbox fixtures and a dry-run session. No real run was performed.
