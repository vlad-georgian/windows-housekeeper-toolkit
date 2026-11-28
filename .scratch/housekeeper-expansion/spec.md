# Windows Housekeeper expansion

This plan captures the decisions from the design discussion and the approved implementation breakdown.

## CLI and unattended runs

- Show four unchecked choices on launch. Remove caches, remove old data and installations, move apps to another drive, and manage automatic startup. Reuse `A` to toggle all four choices.
- Use allowlisted targets throughout. Gather choices before showing one combined plan for confirmation. Cancelling a prompt leaves the plan unapplied. Keep dry runs and cleanup audit summaries.
- Remove `--all` and `--app`. Unattended cleanup requires explicit category selection. Destructive cache cleanup requires its category to be named explicitly. Keep the app checklists in interactive cleanup.
- Preserve an enabled sign-in cleanup job and any saved selections that map to the general cache catalog. Keep startup preference enforcement independently configurable.

## Cleanup

Selecting cache cleanup opens these checklists in order.

1. **General cache cleanup.** Include known regenerable caches for supported apps such as Codex, Claude, Discord, and GitHub Desktop.
2. **Destructive cache cleanup.** Start with every item unchecked, including when the user toggled all top-level operations. Cover verified package download caches for npm, Bun, Scoop, Chocolatey, and NuGet where present. Preserve installed packages and active shared stores. Show which cleanups can cause redownloads or affect offline use.
3. **Per-user Windows temporary directories.** Include Temp and the conventional per-user Temporary Internet Files cache. Attempt all eligible entries regardless of age. Continue past locked or inaccessible entries, keep the root directories, and avoid following links outside the intended cleanup area.

Keep one cleaner file per app within each applicable operation. Split cache cleaners from cleaners for old data and installations. Classify each candidate by what the underlying data is. A single app can appear in more than one operation.

Old-data and installation cleanup is limited to verified per-user targets. Cover Codex standalone and daemon releases, existing supported desktop apps including GitHub Desktop, Scoop installations including Node.js, Vite+ releases, native Claude Code versions, and VS Code extensions explicitly marked obsolete. Preserve installed extensions still in use and active or staged updater payloads.

For Codex, apply latest-only cleanup independently to each release store. Preserve the selected release, in-use releases, and staged newer versions. A recorded previous release can be eligible once it passes verification. For other apps, preserve any explicitly recorded fallback. Recheck version selections and relevant processes at removal time.

## Application relocation

- Retire the legacy Codex diagnostic-log migration commands entirely. The new operation moves verified per-user installation and data paths grouped by application.
- After the user selects apps to move, ask for a base directory on another fixed local drive. Mirror each original path as `<base>\<profile name>\<profile-relative path>`. For example, `C:\Users\test\AppData\Local\Claude-Data` becomes `E:\Software\test\AppData\Local\Claude-Data`.
- Keep original paths working with directory junctions or file symbolic links where appropriate. A Windows hard link joins file names on the same volume. Treat existing hard-linked files by identity when determining which app-owned files and aliases to move.
- Mark an app as migrated only when all its configured, applicable paths resolve through links to their mirrored destinations under the chosen base. Start migrated applications checked. Leaving one clear requests restoration of the latest data to its original paths. An app with both local paths and paths mirrored under a single base starts clear with a partial migration hint. Leaving it clear restores only those linked paths, and checking it offers to finish the move.
- For mixed layouts, record the original links, their verified targets, and the real paths before replacing links. Consolidate the in-scope data into the chosen layout. Verify copied data, destination permissions, and replacement links before reclaiming source space. Preserve recovery information if a move or reversal is interrupted. Surface a destination conflict before overwriting data.
- Cover the per-user Codex installation and data, including both release stores, and verified Claude CLI and Desktop installation and data paths. Include GitHub Desktop, VS Code extensions, standalone per-user Node.js, Vite+, Bun and npm global package paths, and Scoop and Chocolatey where ownership and user scope are verified.
- Give each physical tree one owner. Node.js bundled with Scoop or Vite+ moves with its manager, as do global packages owned by Bun or npm. Handle shared launchers individually and keep Windows-managed Store binaries and machine-wide Chocolatey packages outside the relocation catalog.

See the [application relocation decision](../../docs/adr/0002-relocate-applications-with-directory-junctions.md).

## Automatic startup

- Offer reversible changes for allowlisted app sign-in entries and individually vetted app-owned services. Preserve the prior setting for restore.
- Change a supported automatic service to Manual without stopping a running instance. Show machine-wide scope and elevation requirements before confirmation. Restore the saved startup mode, including delayed automatic start when applicable.

## Formatting and linting

Keep Oxc formatting and linting in its [existing independent ticket](issues/01-configure-oxc-formatting.md).

## Scope of the earlier manual work

The old Roaming npm copy of Codex was uninstalled. The existing Claude and Zwift relocations were moved under the agreed profile layout, with Zwift at `E:\Software\George\AppData\Local\Zwift`. Those machine-specific changes are already complete.

## Implementation tickets

| Ticket                                                                                                             | Blocked by | End-to-end result                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01 · Configure Oxc formatting and lint checks](issues/01-configure-oxc-formatting.md)                             | None       | Repository format and lint verification.                                                                                                                                                              |
| [02 · Make cache and old-installation cleanup opt-in](issues/02-opt-in-cache-and-installation-cleanup.md)          | None       | Run general caches, destructive caches, and old-installation cleanup from one opt-in CLI workflow. Let the user select supported apps interactively or name a cleanup category for an unattended run. |
| [03 · Clean per-user Windows temporary directories](issues/03-clean-per-user-windows-temporary-directories.md)     | 02         | Offer allowlisted Windows temporary locations as the third cache checklist and as an explicit unattended cleanup category.                                                                            |
| [04 · Clean verified superseded Scoop installations](issues/04-clean-superseded-scoop-installations.md)            | 02         | Offer verified, superseded per-user Scoop installations in the old-installation checklist, including Scoop-managed Node.js.                                                                           |
| [05 · Clean verified old Vite+, Claude Code, and VS Code data](issues/05-clean-old-vite-claude-and-vscode-data.md) | 02         | Add per-user obsolete Vite+ releases, native Claude Code versions, and obsolete VS Code extensions to the old-installation operation.                                                                 |
| [06 · Move and restore user-owned apps](issues/06-move-and-restore-user-owned-apps.md)                             | 02         | Move GitHub Desktop's supported per-user installation and data paths and VS Code's installed extensions to another drive. Restore the latest files from the same checklist.                           |
| [07 · Consolidate existing links during relocation](issues/07-consolidate-existing-links-during-relocation.md)     | 06         | Move and restore verified per-user Codex and Claude installation and data paths, including apps with a mix of local directories, pre-existing links, and individually owned launcher files.           |
| [08 · Relocate package managers and their runtimes](issues/08-relocate-package-managers-and-runtimes.md)           | 07         | Offer reversible relocation of verified per-user Node.js, Vite+, Bun, npm, Scoop, and Chocolatey installation or package paths.                                                                       |
| [09 · Manage app startup from the launch menu](issues/09-manage-sign-in-app-startup.md)                            | 02         | Select verified app sign-in entries from the launch menu, confirm the changes, and restore the saved prior settings using the same workflow.                                                          |
| [10 · Manage vetted app service startup](issues/10-manage-vetted-app-service-startup.md)                           | 09         | Turn off automatic startup for individually vetted app-owned Windows services, then restore their original startup modes from the same confirmed workflow.                                            |
