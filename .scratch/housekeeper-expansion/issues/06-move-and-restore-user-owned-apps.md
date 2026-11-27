# 06: Move and restore user-owned apps

Status: ready-for-agent
Type: task
Blocked by: 02

## What to build

Move GitHub Desktop's supported per-user installation and data paths and VS Code's installed extensions to another drive. Restore the latest files from the same checklist.

## Acceptance criteria

- [ ] Select apps from the relocation menu, then prompt for a base on another drive for newly selected apps. Mirror each path under the base, Windows profile name, and its original profile-relative path.
- [ ] Keep original directory paths usable through verified junctions. Verify contents and permissions before reclaiming source space and retain recovery information for incomplete moves.
- [ ] Start an app checked only when all its applicable paths link to their mirrored destinations under the chosen base. Unchecking one requests restoration of the latest contents, with verification before releasing destination space.
- [ ] Report app-in-use conditions and destination conflicts before overwriting data. Verify both move and restore across local volumes with disposable directories.
- [ ] Retire all legacy Codex diagnostic-log migration commands.
