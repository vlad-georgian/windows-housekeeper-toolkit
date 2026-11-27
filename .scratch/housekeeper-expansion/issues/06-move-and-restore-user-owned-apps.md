# 06: Move and restore user-owned apps

Status: resolved
Type: task
Blocked by: 02

## What to build

Move GitHub Desktop's supported per-user installation and data paths and VS Code's installed extensions to another drive. Restore the latest files from the same checklist.

## Acceptance criteria

- [x] Select apps from the relocation menu, then prompt for a base on another drive for newly selected apps. Mirror each path under the base, Windows profile name, and its original profile-relative path.
- [x] Keep original directory paths usable through verified junctions. Verify contents and permissions before reclaiming source space and retain recovery information for incomplete moves.
- [x] Start an app checked only when all its applicable paths link to their mirrored destinations under the chosen base. Unchecking one requests restoration of the latest contents, with verification before releasing destination space.
- [x] Report app-in-use conditions and destination conflicts before overwriting data. Verify both move and restore across local volumes with disposable directories.
- [x] Retire all legacy Codex diagnostic-log migration commands.

## Answer

Resolved on branch `ticket/06-move-restore-apps`.

- **Move apps to another drive** is a launch operation in `src/relocation/`. Migrated applications start checked. Newly checked apps prompt for an absolute base outside the profile on another fixed local volume. Clearing a migrated application restores it. The catalog has one file per app in `src/relocation/apps/`: GitHub Desktop (`%LOCALAPPDATA%\GitHubDesktop` and `%APPDATA%\GitHub Desktop`) and VS Code extensions (`%USERPROFILE%\.vscode\extensions`). Each `RelocatableApp` names the `processGuardId` used by `src/windows/processes.ts`.
- `transfer.ts` provides `moveDirectory` and `restoreDirectory` for one directory. A move copies to a staging directory beside the destination, verifies contents, read-only flags, and write access, renames the original aside, checks that it did not change, creates the junction, and verifies it before removing the old copy. A restore copies back to staging, removes the junction, checks that the destination did not change, swaps the copy in, and verifies it before releasing the destination. Restoration keeps its parent folders because their ownership is unknown.
- `journal.ts` saves a recovery record in `%LOCALAPPDATA%\windows-housekeeper-toolkit\relocation-recovery.json` before each phase. If safe undo or final reclamation fails, the operation keeps the record, holds back that application, and points to the [manual recovery procedure](../../../README.md#recovering-an-interrupted-relocation).
- `inspect.ts` classifies paths as `missing`, `local`, `linked`, or `unsupported`. `moveSteps` keeps paths already linked to their mirrored destination (`in-place`). For a partial relocation under one base, checking the application offers to move its remaining local paths, and leaving it clear restores only its linked paths. A failure on a later path leaves completed transfers in place and reports the completed, failed, and unattempted paths.
- **For ticket 07:** these cases are reported as blocked and left unchanged. Extend these points:
    - paths that link anywhere other than the mirrored destination (`moveSteps` → `blocked`)
    - trees containing links or hard-linked files (`UnsupportedTreeError` in `tree.ts`)
- `LaunchPrompts` gained `text()`, and `FakePrompts` now records `texts` and `logs`. `src/test-support/rejection.ts` helps assert rejected promises, because Bun's `rejects` matcher is not thenable for the type-aware linter.
- The transfer compares the owner, group, and discretionary ACL of each directory and file, and tests write access. It stops if permissions differ or cannot be verified. Before reclaiming either old tree, it verifies the full surviving tree at its final path.
- Relocation failures count in the cleanup summary's failures and skipped running apps, so the closing summary still leads with cleanup bytes.
- The legacy `migration` command and `src/windows/migration/` are removed.
- Verification: `bun test` (68 tests, plus 2 opt-in cross-volume tests) and `bun run check`. The cross-volume test moved and restored a sandbox between C: and E:, run with `HOUSEKEEPER_TEST_OTHER_VOLUME` set to a disposable directory. No real, non-dry run of the CLI was performed.

## Comments

The PR review clarified the transfer contract for tickets 07 and 08. The `copying` phase keeps the verified copy in staging. The `swapping` phase covers placing it at the final path. Rollback proves it placed the destination and checks its identity before removal. It prunes only empty parents created in that move, verified again by identity.

The `moveDirectory` and `restoreDirectory` entry points still accept the same arguments. When adding a confirmed plan, capture destination identities with `inspectDestinationPath` and pass them through `TransferOptions.destinationDirectories`, as the launch operation does now. The transfer entry points require plain directory ancestors, so link consolidation must verify and resolve legacy link targets before passing real directory paths to these primitives. The drive-type lookup remains injectable. `src/windows/drives.ts` owns the drive types and `layout.ts` still re-exports them.

The Spec and Standards re-checks tightened the same seams. `linksTo` requires a direct stored target. App inspection can return a blocked reason, including out-of-profile data and an ineligible inferred base. Retained paths in partial moves must carry their planned identities into apply. `snapshotTree` includes Windows permissions for the root and all entries, so callers should build manifests through it.

Reclamation now pins both trees with Windows handles that deny write and delete sharing, verifies ACLs and contents under those handles, and deletes only validated old entries by handle. `removeTree` accepts an optional fifth argument naming the survivor's path and identity. Both directory transfer entry points supply it, keeping their existing arguments. Downstream file-transfer implementations should use the same guarded reclamation contract. The optional `afterVerifyingSurvivor` transfer hook supports deterministic fixture interruptions before handle acquisition. A sharing conflict, unsupported deletion, or mismatch retains recovery. A late new entry survives and makes its parent nonempty, so reclamation may finish only partly. The README records the guarantees and limits.

Ticket 07 can use the exported `ReclamationGuard` boundary in `windows/reclaim-tree.ts` for held path ancestry and expected junctions. `removeTree` accepts these guards in its optional sixth protection argument. Both directory transfer operations now supply captured ancestry, and move additionally supplies the created original junction's identity and destination. Native no-follow checks validate the junction tag and stored payload while keeping its handle open through reclamation. Tree entries continue rejecting reparse points. The fixture-only `failReclamationAfter` option tests late partial deletion. Transfer entry-point arguments remain compatible.
