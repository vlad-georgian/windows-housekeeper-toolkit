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

- **Vite+** (`vite-plus-releases`): the selected release is the `current` junction under `VP_HOME` (default `~\.vite-plus`). The recorded fallback is `.previous-version`. Both are preserved, as are newer releases. An unparseable fallback marker disables the cleaner. **Unverified assumption:** the layout (version directories each holding a `package.json` whose `version` matches the directory name, a `current` link, a `.previous-version` file) comes from memory of the Vite+ installer, because no Vite+ installation exists on the development machine. If the real layout differs the cleaner offers nothing rather than guessing. Please confirm against a real `~\.vite-plus` before relying on it.
- **Claude Code** (`claude-code-versions`, already existed): the active version now comes from the native launcher `~\.local\bin\claude.exe` (run by absolute path, or its link target), never `claude` on `PATH`. Only versions older than the active one qualify, and versions in use are skipped. The cleaner now checks running binaries by path (`manualRunningAppCheck = false`) instead of blocking whenever any Claude process runs, because Claude Code is usually running during a manual cleanup.
- **VS Code** (`vscode-extensions`): only `~\.vscode\extensions\.obsolete` entries marked `true` qualify, and any folder still listed in `extensions.json` is preserved. Both files must parse or nothing is offered. The VS Code app-level running check still applies. Only the stable `.vscode` directory is covered, not Insiders or forks.
- The shared helper `running-paths.ts` lists running process paths. Metadata is revalidated at removal for all three cleaners. Tests cover each candidate type and each protected version using sandbox fixtures and a dry-run session. No real run was performed.
