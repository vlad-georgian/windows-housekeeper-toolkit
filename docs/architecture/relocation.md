# Application relocation

The **Move apps to another drive** launch operation moves a supported app's
per-user directories under a base on another drive and keeps each original
path usable through a directory junction. See
[ADR 0002](../adr/0002-relocate-applications-with-directory-junctions.md).

Each original path is mirrored as `<base>\<profile name>\<profile-relative path>`.
An app starts checked only when every applicable path links to its mirrored
destination under one base. Checking an unmigrated app moves its local paths,
and paths that already link to the mirrored destination stay as they are.
Clearing a migrated app restores the latest contents to the original paths.

| File                                                          | Responsibility                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/`](../../src/relocation/apps)                          | The relocation catalog, one file per app. Each app lists its per-user paths and the process guard ID used to detect it in use.               |
| [`index.ts`](../../src/relocation/index.ts)                   | Wires the operation to the current profile, Windows processes, the recovery journal, and the run's audit log and summary.                    |
| [`operation.ts`](../../src/relocation/operation.ts)           | Shows the app checklist, asks for the base, plans moves and restores, reports conflicts and running apps, and applies or previews the plan.  |
| [`inspect.ts`](../../src/relocation/inspect.ts)               | Classifies each path as missing, local, linked, or unsupported, decides whether an app is migrated, and plans each path's move under a base. |
| [`layout.ts`](../../src/relocation/layout.ts)                 | Builds mirrored paths, recovers a base from a destination, compares volumes, and validates a base.                                           |
| [`directory-path.ts`](../../src/relocation/directory-path.ts) | Checks containment and captures directory identities for planning, transfer, and rollback.                                                   |
| [`transfer.ts`](../../src/relocation/transfer.ts)             | Moves or restores one directory with a verified copy and junction swap, and undoes a transfer interrupted before its swap is verified.       |
| [`tree.ts`](../../src/relocation/tree.ts)                     | Snapshots, copies, verifies, and removes plain directory trees. Links, hard-linked files, and special files are reported as unsupported.     |
| [`journal.ts`](../../src/relocation/journal.ts)               | Saves a recovery record in `relocation-recovery.json` before each transfer phase and removes it once the transfer finishes.                  |

## Moving a directory

1. Check that the destination is below the relocation base and its ancestor
   directories resolve directly. Capture their identities when planning and
   check them again during transfer. Refuse an existing destination, then hash
   every file in the source tree.
2. Create missing destination parents one at a time and record the directories
   created during this transfer.
3. Copy the tree to a staging directory beside the destination, verify the
   contents, read-only flags, and that the current user can read and write
   the copy, then rename it into place.
4. Rename the original aside, verify it did not change during the copy,
   create the junction, and verify that it resolves to the destination.
5. Verify the identity of the placed copy, then verify and remove the
   set-aside original.

## Restoring a directory

1. Copy the destination to a staging directory beside the original path and
   verify it.
2. Remove the junction, verify the destination did not change during the
   copy, and rename the staging directory into the original path.
3. Remove the destination after verifying its identity and contents. Restore
   keeps its empty parents because their ownership is unknown.

After a failure before the swap is verified, the transfer attempts to undo
its changes. Move rollback removes the destination only after successful
placement and verification against the staging directory's identity and
contents. It prunes only empty parents it created below the base and can still
verify by identity. The record is kept if safe undo or final reclamation
fails. The operation holds back the affected app and points to the journal
and the [manual recovery procedure](../../README.md#recovering-an-interrupted-relocation).

## Tests

Tests use disposable sandbox profiles and never touch the real profile. The
cross-volume test runs only when `HOUSEKEEPER_TEST_OTHER_VOLUME` names a
writable directory on a different local volume from the system temporary
directory. It creates and removes its own directory there.

```powershell
$env:HOUSEKEEPER_TEST_OTHER_VOLUME = 'E:\scratch'; bun test src/relocation
```
