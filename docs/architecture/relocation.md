# Application relocation

The **Move apps to another drive** launch operation moves a supported app's
per-user paths under a base on another drive. Original directories use junctions
and individually owned files use file symbolic links. See
[ADR 0002](../adr/0002-relocate-applications-with-directory-junctions.md).

Each original path is mirrored as `<base>\<profile name>\<profile-relative path>`.
An app starts checked only when every applicable path links to its mirrored
destination under one eligible base. The operation checks stored targets and
compares the inferred volume with the original parent volume. A partial move
revalidates any installed links before transferring its remaining paths.
Clearing a migrated app restores the latest contents to the original paths.

| File                                                          | Responsibility                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/`](../../src/relocation/apps)                          | The relocation catalog, one file per app. Each app lists its per-user paths and the process guard ID used to detect it in use.                                   |
| [`index.ts`](../../src/relocation/index.ts)                   | Wires the operation to the current profile, Windows processes, the recovery journal, and the run's audit log and summary.                                        |
| [`operation.ts`](../../src/relocation/operation.ts)           | Shows the app checklist, asks for the base, plans moves and restores, reports conflicts and running apps, and applies or previews the plan.                      |
| [`inspect.ts`](../../src/relocation/inspect.ts)               | Classifies each path as missing, local, linked, or unsupported, decides whether an app is migrated, and plans each path's move under a base.                     |
| [`layout.ts`](../../src/relocation/layout.ts)                 | Builds mirrored paths, recovers a base from a destination, compares volumes, and validates a base.                                                               |
| [`directory-path.ts`](../../src/relocation/directory-path.ts) | Checks containment and captures directory identities for planning, transfer, and rollback.                                                                       |
| [`transfer.ts`](../../src/relocation/transfer.ts)             | Moves or restores one directory or file with a verified copy and a junction or file-symlink swap, and undoes a transfer interrupted before its swap is verified. |
| [`tree.ts`](../../src/relocation/tree.ts)                     | Inventories links without recursing into them, copies hard-linked names by identity, verifies contents and permissions, and removes verified entries.            |
| [`journal.ts`](../../src/relocation/journal.ts)               | Saves a recovery record in `relocation-recovery.json` before each transfer phase and removes it once the transfer finishes.                                      |

## Codex and Claude ownership

- Codex uses `~/.codex` for state and both `packages/standalone` and
  `packages/app-server-daemon`. The default visible installation lives under
  `%LOCALAPPDATA%/Programs/OpenAI/Codex`. Keep its nested release selectors
  and the link from the visible bin directory. The packaged profile is scoped
  to the Codex family. [OpenAI Windows installer](https://github.com/openai/codex/blob/main/scripts/install/install.ps1) · [Microsoft Store identity](https://apps.microsoft.com/detail/9plm9xgg6vks)
- Claude Code owns its native release store, `~/.claude`, and `~/.claude.json`.
  Verify `~/.local/bin/claude.exe` against a native version by file identity or
  content digest. Other launchers in that directory keep their names and data.
  [Claude Code setup](https://code.claude.com/docs/en/setup) · [Claude Code settings](https://code.claude.com/docs/en/settings)
- Claude Desktop supports the per-user AnthropicClaude installation, Roaming
  profile, Claude-Data and packaged Roaming profiles for the Anthropic MSIX and
  Microsoft Store identities. WindowsApps and machine-wide binaries are excluded.
  [Installation](https://claude.com/docs/third-party/claude-desktop/installation) · [Data locations](https://claude.com/docs/third-party/claude-desktop/move-to-claude-enterprise) · [Microsoft Store identity](https://apps.microsoft.com/detail/9P6K58THS811)

A direct link to an older profile mirror can be consolidated. A legacy location
outside the mirror needs catalog evidence, such as a Codex release manifest or a
Claude-Data package configuration. The journal records the original link and
backing identity before the swap. A verified destination created by the toolkit
has an identity receipt in `relocation-destinations.json`. On consolidation, its
old name forwards to the original path before its backing copy is removed.
Unrecorded backing stores remain intact, including on restore. Codex and Claude
keep recorded mirror names live after restore. When a subsequent move selects
the same destination, it can replace its own verified forwarding link. An alias
record retains verified copy identities across partial application transfers.
Codex’s visible bin keeps targeting the original standalone selector when its
payload matches the selected release store. Links to unavailable targets and
read-only hard links block the transfer.

## Package-manager ownership

The catalog verifies package paths inside the profile before offering them and
rechecks ownership at apply time. Standalone Node.js needs a Node executable
and a bundled npm manifest in a known per-user installation directory.

Each manager's locations come from its own configuration: Scoop's
`config.json`, npm's user and bundled npmrc files, and Bun's global
`bunfig.toml`. Environment variables are read from the injected catalog
sources, never from the ambient process. When two sources disagree, or a file
cannot be read, the manager is not offered and the checklist log gives the
reason.

A path the toolkit relocated keeps its identity receipt in
`relocation-destinations.json`, with the app that moved it and the original
path. Receipts, not the current configuration, decide what a restore covers.
When the app's ownership evidence disappears, its configured location changes,
or its configuration now blocks it, the receipt keeps each relocated path in
the checklist so it can be restored, but not moved again. A restore that
leaves any recorded or configured path of the app linked under its base is
reported as failed. Receipts from earlier versions name no app; a path they
record that still links to its mirror is logged.

- Scoop moves its whole root after verifying the Scoop launcher in a release
  under `apps`. Scoop persists directories as junctions and files as hard
  links between a version in `apps` and `persist`, on every later install or
  update too. A hard link cannot span drives, so `apps` and `persist` move as
  one tree and stay on one volume. The mover re-creates the internal
  junctions and hard links, and junctions from outside keep resolving through
  the root's link. Scoop is held back while a file in the root has a hard-link
  name outside it. Planning checks this, and the transfer checks the same
  snapshot it verifies and reclaims.
  Receipt-only restores keep that policy. While relocated, Scoop spells new
  junctions through its original root. A transfer treats a payload under the
  original path or the mirror as internal to the tree, so the source and the
  copy classify it the same way, and it refuses a link the copy would classify
  differently before anything is copied. Links keep their read-only attribute,
  which Scoop sets with `attrib +R /L`. Every Scoop root, the default
  `~scoop` included, must hold only Scoop's own folders: `apps`, `buckets`,
  `cache`, `persist`, `shims`, `modules` and `workspace`. Any other entry, even
  a stray file, holds Scoop back with the entries listed. A root that moved
  before this check stays restorable through its receipt.
  [Scoop folder layout](https://github.com/ScoopInstaller/Scoop/wiki/Scoop-Folder-Layout)
- Vite+ verifies the launcher and active release manifest before moving its
  managed releases and runtimes. The shared launcher directory stays in place.
  [Vite+ Windows installation](https://github.com/voidzero-dev/vite-plus/blob/main/CONTRIBUTING.md#windows)
- npm moves verified global `node_modules` and the npm content cache.
  The prefix's launcher files stay in place.
  [npm folders](https://docs.npmjs.com/cli/configuring-npm/folders/)
- Bun checks the global installation manifest and lockfile. It can also move
  a verified download cache when that cache has no shared global store.
  Existing global launchers keep their paths. Bun hard-links installed files to
  its cache, so both trees move in one action and keep those links. The plan
  counts files that also have names elsewhere, such as project installs. Those
  names keep their own copies on the original drive.
  [Bun configuration](https://bun.com/docs/runtime/bunfig)
- Chocolatey verifies the user-profile installation layout and checks the
  machine setting before offering to move the package library. The binary
  and shims stay in place.
  [Chocolatey non-administrative installation](https://docs.chocolatey.org/en-us/choco/setup/#non-administrative-install)

The planner gives a configured path and its descendants to one catalog owner
before building the checklist. This keeps an npm prefix inside Scoop or Vite+
with the manager. Distinct roots that point into overlapping backing trees
are held back until their ownership is unambiguous.

## Moving a directory

1. Check that the destination is below the relocation base and its ancestor
   directories resolve directly. Capture their identities when planning and
   check them again during transfer. Refuse an existing destination, then hash
   every file in the source tree.
2. Create missing destination parents one at a time and record the directories
   created during this transfer.
3. Copy the tree to a staging directory beside the destination, verify the
   contents, read-only flags, Windows owner, group, discretionary access rules,
   and the current user’s write access, then rename it into place.
4. Rename the original aside, verify it did not change during the copy,
   create the junction, and verify that it resolves to the destination.
5. Verify the set-aside original and the placed copy’s identity, contents,
   permissions, and link before releasing the old copy.

## Restoring a directory

1. Copy the destination to a staging directory beside the original path and
   verify it.
2. Rename the link aside, verify the destination did not change during the
   copy, and place the verified staging copy at the original path.
3. Remove a recorded destination after verifying its identity and contents. Restore
   keeps its empty parents because their ownership is unknown.

After a failure before the swap is verified, the transfer attempts to undo
its changes. Move rollback removes the destination only after successful
placement and verification against the staging directory's identity and
contents. It prunes only empty parents it created below the base and can still
verify by identity. Set-aside, placement and rollback moves never replace an
existing entry, so a file the app writes at a target path is kept. The
record is kept if safe undo or final reclamation fails. The operation holds back the affected app and points to the journal
and the [manual recovery procedure](../../README.md#recovering-an-interrupted-relocation).

`windows/reclaim-tree.ts` performs the final reclamation through Windows
handles. It opens all expected entries of both copies with read sharing,
checks volume, file ID, creation time, type, links, attributes, ACLs, directory
membership, and file hashes, then deletes only retiring handles in reverse
tree order. Write probes and the earlier survivor callback finish before these
final hashes. The survivor handles stay open until deletion ends. A new entry
is never added to the deletion list. If it appears after enumeration, Windows
refuses deletion of its nonempty parent and the transfer keeps its journal.
Any failure before deletion preserves the old tree. A later failure may leave
the old tree partly reclaimed, with its changed entries and recovery record.

The same native held set includes the captured ancestry of both paths and,
for moves, the original junction or file symlink. A `ReclamationGuard` binds
the path identity to its expected stored target when it represents a link. Ancestors are acquired in path
order with no-follow handles and checked as plain directories. Junctions are
checked by file identity and `FSCTL_GET_REPARSE_POINT` for the supported tag
and exact stored target. The same no-follow check applies to file symlinks. Security descriptors are read with `GetSecurityInfo`
on the held objects. Inside a tree, only junctions to folders and file
symlinks to files are supported. Planning reads each link's reparse tag and
blocks directory symlinks, file symlinks to folders and other reparse points.

A file with several names uses write-denying read handles and a delete handle
for one verified name at a time. Reclamation enumerates the full alias set and
rechecks it against the opened deletion handle. An alias outside the retiring
paths remains in place. Link removal uses the NTFS disposition operation and
keeps the read-only attribute intact.

## Tests

Tests use disposable sandbox profiles and never touch the real profile. The
cross-volume test runs only when `HOUSEKEEPER_TEST_OTHER_VOLUME` names a
writable directory on a different local volume from the system temporary
directory. It creates and removes its own directory there.

```powershell
$env:HOUSEKEEPER_TEST_OTHER_VOLUME = 'E:\scratch'; bun test src/relocation
```
