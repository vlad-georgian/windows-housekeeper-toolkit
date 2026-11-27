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

Run `vp run start` to open the launch menu. Every choice starts unchecked. Use
the arrow keys to move, **Space** to toggle an item, **A** to toggle all, and
**Enter** to confirm. **Remove caches** opens the general cache checklist, then
a separate checklist of package download caches that shows the redownload and
offline-use implications, then a checklist of per-user Windows temporary
directories. **Remove old data and installations** lists apps with
superseded releases or installer payloads. The CLI gathers every choice, then
shows one combined plan to confirm. Cancelling any prompt applies nothing.
Close the selected apps before removal.

For an unattended run, name each cleanup category with `--category`:
`general-cache`, `destructive-cache`, `windows-temp`, or `old-installations`.
Destructive caches and Windows temporary directories run only when their
category is named.

```powershell
vp run start --dry-run
vp run start --dry-run --category general-cache
vp run start --category general-cache --category old-installations
vp run start --category destructive-cache --log-dir D:\cleanup-logs
vp run start --dry-run --category windows-temp
```

Dry runs show the candidate path, reason, and known space by storage drive.
The CLI checks resolved paths and counts aliases once. It preserves worktrees,
conversations, generated files, settings, credentials, installed plugins,
installed packages, pending updates, and active versions. NVIDIA Driver Store
removal is manual and requires elevation.

General cache cleanup covers Codex, Claude Code, Claude Desktop, Discord,
GitHub Desktop, and VS Code caches. Destructive cache cleanup covers per-user
npm, Bun, Scoop, Chocolatey, and NuGet download caches. Windows temporary
directory cleanup empties the per-user Temp directory and Temporary Internet
Files cache (`%LOCALAPPDATA%\Microsoft\Windows\INetCache`) regardless of file
age. It keeps both folders, removes links without following them, and skips
locked or inaccessible entries while reporting them in the summary and audit
log. Machine-wide Windows temporary folders are never touched.
Old-installation cleanup keeps only the selected release in each Codex release store and any staged
update, and covers superseded native Claude Code binaries (judged by the native
launcher, not `claude` on `PATH`), superseded Vite+ releases (in `VP_HOME`,
`~\.vite-plus`, or `%LOCALAPPDATA%\vite-plus\data`, preserving the active
release and the recorded rollback release, and skipped while the Vite+ installer
runs), VS Code extension folders that VS Code marks obsolete and no longer lists
as installed, Squirrel desktop apps such as GitHub Desktop and Discord, and
updater payloads for installed updates. The
default manual audit directory is `./logs`. Each file is named
`windows-housekeeper-toolkit-<timestamp>-<pid>.log`.

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

Cleanup and startup preference enforcement have independent switches. Sign-in
cleanup runs only general cache cleanup and requires an explicit list of its
cleaner IDs. Saved selections from other categories stay saved but are
excluded, and `signin status` lists them. It skips running apps and posts one
Windows notification with the outcome and an audit log link. Sign-in logs and
preferences live under `%LOCALAPPDATA%\windows-housekeeper-toolkit`.

```powershell
vp run start signin status
vp run start signin cleanup enable --apps vscode,codex
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
