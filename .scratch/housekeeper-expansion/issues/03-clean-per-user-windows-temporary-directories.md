# 03: Clean per-user Windows temporary directories

Status: resolved
Type: task
Blocked by: 02

## What to build

Offer allowlisted Windows temporary locations as the third cache checklist and as an explicit unattended cleanup category.

## Acceptance criteria

- [x] List per-user Temp and the conventional per-user Temporary Internet Files cache after general and destructive cache cleanup.
- [x] Attempt all eligible contents with no age cutoff. Skip locked or inaccessible entries and continue with siblings.
- [x] Keep the root folders and avoid following links beyond their intended cleanup locations. Machine-wide Windows temporary folders are outside this category.
- [x] Preview eligible targets and report skips. Verify on disposable Windows data that a locked file remains while an unlocked sibling is removed.

## Comments

Resolved on branch `ticket/03-temp-directories`.

- New category `windows-temp`, the third checklist of **Remove caches** after general and destructive cache cleanup. It never runs at sign-in and runs unattended only with `--category windows-temp`.
- Cleaners `user-temp` (`SystemPaths.temp`) and `internet-cache` (`%LOCALAPPDATA%\Microsoft\Windows\INetCache`) live in `src/cleaners/windows-temp/` and share `temporary-contents-cleaner.ts`. Each root is one candidate; the folder is kept and every entry is attempted regardless of age.
- Removal and detection are in `src/core/filesystem/temporary-contents.ts`. The existing strict removal (`removeFilesystemCandidate`) aborts on any link, hard link, or unreadable child, so it is not used here. The new code removes junctions and symbolic links without following them, re-checks each directory's real path before descending, and reports entries it cannot delete.
- `RemovalCallbacks` gained an optional `onSkipped`. Skips are counted in `CleanupSummary.skippedEntries`, written as `entry-skipped` audit records, and shown in the summary. They do not count as failures or change the exit code.
- A root is offered only when it is a real directory (not a link) that equals or lies inside `<LocalAppData>\Temp` (user-temp) or equals `<LocalAppData>\Microsoft\Windows\INetCache`. A `TEMP` pointing anywhere else, including `D:\Temp` or a profile folder such as Documents, is not offered. Relaxing this is a decision for the owner.
- The legacy `Temporary Internet Files` path under `Microsoft\Windows` is a compatibility link to `INetCache`, so only `INetCache` is listed.
- Verification used disposable sandboxes only. `bun test` includes a Windows-only test where a PowerShell process opens a sandbox file without sharing: the locked file remains and its unlocked sibling is removed. No real (non-dry) run was performed on the development machine.
- The active audit log file is kept, and reported as skipped, when the log directory is inside the Temp directory being emptied.
