# windows-housekeeper-toolkit

A Windows CLI for clearing redundant app files, managing app startup preferences,
and moving eligible app data to another drive. Cleanup writes a JSON Lines audit log.

## Install and scan

Install [Vite+](https://viteplus.dev/guide/), then run these commands from the
workspace. Vite+ uses the Bun 1.4.3 pin in the project.

```powershell
vp install --frozen-lockfile
vp run scan
vp run start --help
```

Run `vp run start` to choose applications interactively. The CLI announces the
scan before showing the menu. Use the arrow keys to move, **Space** to toggle
each app, **A** to toggle all, and **Enter** to confirm. Close the selected apps
before removal.

```powershell
vp run start --dry-run --app codex
vp run start --app vscode
vp run start --all --log-dir D:\cleanup-logs
```

Dry runs show the candidate path, reason, and known space by storage drive.
The CLI checks resolved paths and counts aliases once. It preserves worktrees,
conversations, generated files, settings, credentials, installed plugins, and
active versions. NVIDIA Driver Store removal is manual and requires elevation.

The catalog includes Codex's independently selected standalone and daemon
releases, supported Claude Code binaries and Claude Desktop caches, VS Code
caches, verified OpenCode Desktop installer payloads, and the existing
application and package-cache cleaners. The default manual audit directory is
`./logs`. Each file is named `windows-housekeeper-toolkit-<timestamp>-<pid>.log`.

## App startup and updates

App controls accept `codex`, `claude`, `t3-code`, and `opencode`. Inspect status
to see which entries are available for each installed variant.

```powershell
vp run start startup status
vp run start startup disable t3-code
vp run start startup restore t3-code
vp run start startup settings
vp run start updates status
vp run start updates disable codex
```

Startup disable and restore apply to verified per-user Run entries. If an app
has multiple eligible entries, use the entry identifier from status. Use
Windows **Settings → Apps → Startup** for packaged launch entries. Status also
reports relevant Windows services and entries that require Windows or manual
management.

The update command requires a verified package-specific App Installer policy
with launch checks enabled. Status explains when the installed variant updates
in-app, has an all-or-nothing control, or has no verified background mechanism
the CLI can disable while preserving in-app updates.

## Windows sign-in

Cleanup and startup preference enforcement have independent switches. Cleanup
requires an explicit list of eligible cleaner IDs. It skips running apps and
posts one Windows notification with the outcome and an audit log link. Sign-in
logs and preferences live under `%LOCALAPPDATA%\windows-housekeeper-toolkit`.

```powershell
vp run start signin status
vp run start signin cleanup enable --apps vscode,opencode
vp run start signin enforcement enable
vp run start signin cleanup disable
vp run start signin enforcement disable
```

Enforcement reapplies preferences saved by `startup disable` when the task
runs. An app that starts before the task runs may already be open. If you move
the workspace or replace the Bun executable, rerun the relevant enable
command to refresh the task's paths.

## Data migration

```powershell
vp run start migration status
vp run start migration move codex-logs --destination E:\Codex-diagnostics
vp run start migration rollback codex-logs
```

Close Codex, including its desktop and background processes, before moving or
restoring diagnostic logs. Run the command in a separate terminal. The
destination must be on a different local drive and suitable for the files
listed by migration status. The move verifies the copied files and Codex's
`log_dir` setting before reclaiming the source. Rollback copies and verifies
the latest diagnostic files back before restoring the prior setting. Use
`migration resume codex-logs` if an operation is interrupted.

Migration status reports other candidates and existing redirects, including
Claude Desktop data already on E:.

## Development

```powershell
vp fmt
vp lint
vp check
```

For a project-local Vite+ invocation on Windows, use
`node node_modules/vite-plus/bin/vp` followed by the Vite+ command.

See the [project documentation](docs/README.md) for the architecture, source
file guide, dependency decisions, implementation spec, and migration decision.
