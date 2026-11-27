# 05: Clean verified old Vite+, Claude Code, and VS Code data

Status: resolved
Type: task
Blocked by: 02

## What to build

Add per-user obsolete Vite+ releases, native Claude Code versions, and obsolete VS Code extensions to the old-installation operation.

## Acceptance criteria

- [x] Verify Vite+'s active release and any recorded fallback, and preserve both. Limited to Vite+ 1.7.0 and later, whose updater takes the installation lock. See the limits below.
- [x] Identify the active native Claude Code version using the native installation, even if a different launcher comes first on `PATH`. Only verified superseded native versions qualify.
- [x] Offer VS Code extension directories only when the app's metadata explicitly identifies them as obsolete. Preserve installed extensions that remain in use.
- [x] Revalidate the metadata before removal and demonstrate each candidate type and each protected version in a dry run or disposable fixture.

## Comments

### Answer

- **Vite+** (`vite-plus-releases`): the selected release is the `current` junction in the data directory. The recorded fallback is `.previous-version`. Both are preserved, as are newer releases, and names are compared without regard to case. Versions are ordered by SemVer precedence, so a prerelease sorts before its release. `+force.<pid>.<nanos>` reinstall directories count as releases. A directory is only a release when its `package.json` is the installer's wrapper: name `vp-global`, a version equal to the directory's, and a `vite-plus` dependency of that version.
    - The data directory follows Vite+'s own resolution: `VP_HOME`, else `~\.vite-plus` when it holds a `current` link, else the `VP_DATA_DIR` group when all three `VP_*_DIR` variables are set, else `%LOCALAPPDATA%\vite-plus\data`. A `~\.vite-plus` that exists but cannot be read as a directory, or is a dangling link, disables the cleaner rather than falling through to the split layout.
    - A release is a pnpm install, so it contains junctions and hardlinked files. The candidate sets `unlinkTreeLinks`, and removal goes through handle-anchored deletion. The root must be the detected object, every directory being emptied is held open without delete sharing, and entries are deleted through their verified handles, so neither a junction nor another plain directory can be swapped in and a checked entry cannot be renamed away (ADR 0003).
    - **Limit, rollback coordination:** Vite+ takes `<data>\.install.lock` during upgrades and rollbacks only from 1.7.0. Versions 1.6.0 and earlier roll back with no lock, so nothing can keep a rollback from swapping `current` after our checks. The cleaner therefore offers nothing unless the active release is 1.7.0 or later. For 1.7.0 and later it takes the same lock without waiting, reads `current` and `.previous-version` only after holding it, and keeps it until removal ends. The store is resolved once and used for the whole sequence, and the store directory and the lock file are held open without delete sharing, so they cannot be renamed or replaced while the lock is held. A held, missing, linked, or unavailable lock means nothing is offered. The cleaner never creates the lock file. A fallback marker that names a link is resolved while the lock is held, and the release it really reaches is preserved. A fallback that resolves outside the store, or whose data cannot be read, disables the cleaner. Only a confirmed missing marker counts as no fallback.
    - **Limit, running processes:** a release in use is detected from executable paths and, for `node` and `bun`, from command lines that name the release. A runtime whose command line Windows withholds blocks the cleaner, because it cannot be told from a Vite+ child. Command lines are checked against both the physical release path and the same release under the logical home, such as a relocated `~\.vite-plus`. A process started through `current` names that link rather than a release, so it is not matched.
    - The layout was checked against the Vite+ docs and upstream source (v1.5.1 and v1.7.0 and later), not against a real installation, because none exists on the development machine. If a real layout differs the cleaner offers nothing.
- **Claude Code** (`claude-code-versions`, already existed): the active version comes from the native launcher `~\.local\bin\claude.exe` (run by absolute path), never `claude` on `PATH`. Only versions older than the active one qualify, and versions in use are skipped. A launcher that is a link is not trusted. The cleaner checks running binaries by path (`manualRunningAppCheck = false`) instead of blocking whenever any Claude process runs, because Claude Code is usually running during a manual cleanup. A Claude process whose path cannot be read, such as an elevated one, blocks the check.
- **VS Code** (`vscode-extensions`): only `~\.vscode\extensions\.obsolete` entries marked `true` qualify, and any folder still listed in `extensions.json` is preserved. Both files must parse or nothing is offered. The default registry and every `%APPDATA%\Code\User\profiles\<id>\extensions.json` are consulted, and metadata files up to 4 MiB are read. A `profiles` directory that exists but cannot be listed disables the cleaner. The VS Code app-level running check still applies. Only the stable `.vscode` directory is covered, not Insiders or forks.
- The shared helper `running-paths.ts` lists running process paths and runtime command lines, and the Codex cleaner uses it too. Metadata is revalidated at removal for all three cleaners. Tests cover each candidate type and each protected version using sandbox fixtures and a dry-run session. No real run was performed.
