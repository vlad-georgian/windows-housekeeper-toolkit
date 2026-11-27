# windows-housekeeper-toolkit

A Windows CLI for clearing redundant app files, managing app startup preferences,
and moving supported apps to another drive. Cleanup writes a JSON Lines audit log.

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
update, and covers superseded Claude Code binaries, Squirrel desktop apps such
as GitHub Desktop and Discord, and updater payloads for installed updates. The
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

## Moving apps to another drive

Choose **Move apps to another drive** in the launch menu to relocate GitHub
Desktop's per-user installation and data, or VS Code's installed extensions.
Migrated applications start checked. For newly checked apps, enter a
base directory on another fixed local drive. Each path is mirrored under the base,
your Windows profile name, and its profile-relative path, so
`C:\Users\you\AppData\Local\GitHubDesktop` moves to
`E:\Software\you\AppData\Local\GitHubDesktop` with a base of `E:\Software`.
The original path becomes a directory junction, so the app keeps working.

The CLI compares copied files, read-only flags, and Windows owner, group,
and discretionary access rules for every file and directory. It tests write
access and verifies the junction. An ACL difference or an unreadable security
descriptor stops the transfer. Clear a migrated application to restore its
latest files to the original paths. Both operations verify the surviving copy
at its final path before removing the old copy. Restore keeps empty parents.

Reclamation opens every validated entry in both trees with Windows handles
that deny write and delete sharing, then checks identities, permissions,
directory membership, and file hashes again. It deletes only the validated
old entries through those handles. An open writer or a verification failure
keeps the recovery record. A new old-tree entry is left in place and prevents
its parent from being removed. Unsupported handle deletion or an error during
deletion can leave a partially reclaimed old tree beside the verified copy.
These checks rely on Windows file-sharing enforcement and the filesystem's
identity and deletion support. They do not provide a filesystem snapshot or
protection against privileged storage changes.

An application with both local paths and paths mirrored under one base appears
as partially migrated. Check it to finish moving to that base, or leave it
clear to restore the relocated paths. If one path fails during a move or
restore, the CLI reports which paths finished and where it stopped. The plan
reports running apps and existing destinations before any data changes. Close
the apps before applying, or they are skipped. If a transfer leaves a recovery
record, the CLI holds back that application and points to
`%LOCALAPPDATA%\windows-housekeeper-toolkit\relocation-recovery.json`.

An existing junction is eligible for restore when its stored target resolves
directly to the mirrored location on another fixed local volume. An app with
configured data outside the Windows profile is skipped individually.

### Recovering an interrupted relocation

1. Close the affected app and its background processes. Back up the journal,
   find the reported record ID, and preserve the data at its `original`,
   `destination`, `staging`, and `aside` paths. A phase tells you where the
   operation stopped. Verify each copy and junction before moving any files.
2. If the original path is missing, look for the intact original at `aside`
   during a move, or for the verified copy at `staging` during a restore.
   Check which copy contains the latest files, then put a verified copy back
   at the original path. If the original already works, preserve the other
   copies separately until you can account for their contents and ownership.

    For `copying`, the original move source or restore destination is still
    authoritative. Keep `staging` until you have checked it for later changes.
    For `swapping`, inspect the actual directories and junctions because the
    rename may have completed before interruption. Restore service from a
    complete verified copy, keeping all other copies for comparison.

    For `reclaiming`, the destination should hold the final copy and `original`
    should be its junction. For `releasing`, `original` should hold the final
    restored copy. Verify that copy's full contents and permissions. The
    retiring `aside` or destination may already be partly deleted. Preserve
    its remainder, compare it with the final copy, and recover any newer or
    extra files individually before archiving it. A partial tree cannot serve
    as a complete restore source. If the junction or an ancestor changed,
    resolve that mismatch before using any recorded path for recovery.

3. After confirming the app can use the expected files at its original path,
   edit the live journal and remove only the object with this record's ID from
   the JSON array. Keep the backup and all other records. If ownership or the
   latest copy is unclear, leave the record and copies in place until you can
   verify them.

### Reverting a legacy Codex diagnostic-log move

If you previously ran `migration move codex-logs`, close Codex, ChatGPT, and
the Codex app-server before restoring the logs. Find the recorded `home` and
`destination` in `%LOCALAPPDATA%\windows-housekeeper-toolkit\migration-codex-logs.json`.
For a completed move, copy `logs_2.sqlite` and any accompanying `-wal`, `-shm`,
and `-journal` files together from the destination to the recorded `home`
directory, usually `%USERPROFILE%\.codex`. Copy `codex-tui.log`, if present, into
its `log` subdirectory. If the move was interrupted or you are unsure which
copy is current, retain both copies and the journal while checking the migration
state. Before copying back a verified set of logs, move any existing files at
those paths to a separate backup directory so the SQLite files stay together.

Verify the restored files against the destination, then remove the toolkit's
`log_dir` line from `config.toml` in the recorded `home`. It is marked with
`# windows-housekeeper-toolkit` followed by the migration ID. Restart Codex and
confirm it writes logs at the original locations before archiving the old
destination and journal.

## Development

```powershell
vp fmt
vp lint
vp check
```

For a project-local Vite+ invocation on Windows, use
`node node_modules/vite-plus/bin/vp` followed by the Vite+ command.

See the [project documentation](docs/README.md) for the architecture, source
file guide, dependency decisions, implementation spec, and relocation decision.
