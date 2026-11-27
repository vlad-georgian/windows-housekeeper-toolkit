# 07: Consolidate existing links during relocation

Status: resolved
Type: task
Blocked by: 06

## What to build

Move and restore verified per-user Codex and Claude installation and data paths, including apps with a mix of local directories, pre-existing links, and individually owned launcher files.

## Acceptance criteria

- [x] Cover verified user-owned Codex paths, including the standalone and daemon stores, and the applicable paths used by Claude Code and Claude Desktop. Windows-managed Store binaries stay outside the relocation catalog.
- [x] Treat an app with any applicable path outside the expected destination as non-migrated. Preserve its already-correct links when consolidating the remaining paths.
- [x] Inventory each verified original link and the real data it references. Account for hard-linked files by identity, move in-scope real data into the mirrored layout, and replace links after verification. Preserve unrelated data and shared launchers outside the selected app's scope.
- [x] Verify nested junctions and supported file symbolic links remain usable, and that recovery information can identify the original locations on a failed move.
- [x] Demonstrate moving and restoring a mixed layout without silently overwriting a destination or counting a partially relocated app as migrated.

## Answer

The relocation checklist consolidates supported Codex and Claude paths, verifies launcher and link identities, and restores current data. The [relocation architecture](../../../docs/architecture/relocation.md) records the catalog evidence and backing-store ownership rules. Mixed-profile fixtures exercise shared and private backing stores, file symbolic links, junctions, hard-link aliases, identity after failure, and latest-data restore.
