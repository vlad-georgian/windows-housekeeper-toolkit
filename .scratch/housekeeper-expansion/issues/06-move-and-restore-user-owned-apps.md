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

## Comments

Resolved on branch `ticket/06-move-restore-apps`.

- **Move apps to another drive** is a launch operation in `src/relocation/`. Migrated applications start checked. Newly checked apps prompt for an absolute base outside the profile on another fixed local volume. Clearing a migrated application restores it. The catalog has one file per app in `src/relocation/apps/`: GitHub Desktop (`%LOCALAPPDATA%\GitHubDesktop` and `%APPDATA%\GitHub Desktop`) and VS Code extensions (`%USERPROFILE%\.vscode\extensions`). Each `RelocatableApp` names the `processGuardId` used by `src/windows/processes.ts`.
- `transfer.ts` provides `moveDirectory` and `restoreDirectory` for one directory. A move copies to a staging directory beside the destination, verifies contents, read-only flags, and write access, renames the original aside, checks that it did not change, creates the junction, and verifies it before removing the old copy. A restore copies back to staging, removes the junction, checks that the destination did not change, swaps the copy in, and verifies it before releasing the destination. Restoration keeps its parent folders because their ownership is unknown.
- `journal.ts` saves a recovery record in `%LOCALAPPDATA%\windows-housekeeper-toolkit\relocation-recovery.json` before each phase. A failure before the swap is verified is undone and the record removed. Later failures keep the record and raise `IncompleteTransferError`. The operation then holds back that app and points to the journal. There is no automatic resume yet, so the user deletes the listed leftover path and the record by hand.
- `inspect.ts` classifies paths as `missing`, `local`, `linked`, or `unsupported`. `moveSteps` keeps paths already linked to their mirrored destination (`in-place`). For a partial relocation under one base, checking the application offers to move its remaining local paths, and leaving it clear restores only its linked paths. A failure on a later path leaves completed transfers in place and reports the completed, failed, and unattempted paths.
- **For ticket 07:** these cases are reported as blocked and left unchanged. Extend these points:
    - paths that link anywhere other than the mirrored destination (`moveSteps` → `blocked`)
    - trees containing links or hard-linked files (`UnsupportedTreeError` in `tree.ts`)
- `LaunchPrompts` gained `text()`, and `FakePrompts` now records `texts` and `logs`. `src/test-support/rejection.ts` helps assert rejected promises, because Bun's `rejects` matcher is not thenable for the type-aware linter.
- Copies inherit the destination's ACLs. Only read-only flags and the current user's read and write access are verified. Explicit ACLs are not preserved.
- Relocation failures count in the cleanup summary's failures and skipped running apps, so the closing summary still leads with cleanup bytes.
- The legacy `migration` command and `src/windows/migration/` are removed.
- Verification: `bun test` (68 tests, plus 2 opt-in cross-volume tests) and `bun run check`. The cross-volume test moved and restored a sandbox between C: and E:, run with `HOUSEKEEPER_TEST_OTHER_VOLUME` set to a disposable directory. No real, non-dry run of the CLI was performed.

- Follow-up from PR review for ticket 07. The `copying` phase keeps the verified copy in staging. The `swapping` phase now covers placing it at the final path. `createdParent` limits cleanup during a move's undo to folders created by that move. The operation exposes a drive-type lookup alongside the volume comparison for sandbox tests. The standard operation tests exercise partial relocation with an injected volume comparison, and the opt-in tests verify it on two real volumes.
