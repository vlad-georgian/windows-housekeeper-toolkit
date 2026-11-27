# 04: Clean verified superseded Scoop installations

Status: resolved
Type: task
Blocked by: 02

## What to build

Offer verified, superseded per-user Scoop installations in the old-installation checklist, including Scoop-managed Node.js.

## Acceptance criteria

- [x] Determine the selected version and confirm each older candidate from Scoop's installation layout and metadata. Skip ambiguous or incomplete releases.
- [x] Protect current or in-use versions, intentionally retained versions where identified, and Scoop's shared persistent data. Removing an old Node.js version leaves the shared `bin` and `cache` targets usable.
- [x] Recheck the version selection and in-use status before removal. Verify on disposable Scoop-shaped data that old versions are removed and current and persistent data survive.

## Comments

Resolved on branch `ticket/04-scoop-installations`.

- `ScoopInstallationCleaner` (`src/cleaners/installations/scoop-cleaner.ts`, id `scoop-versions`, app `scoop`) is registered in the old-installation checklist. Layout and metadata logic lives in `scoop-installations.ts`.
- An app is considered only when its `current` junction points at a sibling version directory with a valid `manifest.json` and `install.json` whose manifest `version` matches the directory name. A version is eligible when it is strictly older than the selected one, in the same bucket, not marked `hold`, and verified the same way. Non-numeric versions (`nightly`, `2.47.0.windows.2`), `_<version>.old` directories, and incomplete releases are skipped. Newer versions than the selected one are kept, as after `scoop reset <app>@<older>`.
- Persistent data: old version directories hold junctions (directories) and hard links (files) into `persist\<app>`. Detection accepts only links that resolve inside that directory or hard links to declared `persist` files. Anything else makes the version unverifiable. Removal unlinks those links, never following them, then removes the rest with the generic verified removal. Node.js `bin` and `cache` targets survive and stay reachable from the selected version.
- Removal rechecks the selected version, the bucket, `hold`, the directory identity, the link layout, and running processes (image path or command line mentioning the version directory). A process listing failure skips the version.
- Only a per-user Scoop root inside the profile is considered, matching the Scoop cache cleaner. A `SCOOP` override on another drive is not covered. Global installs under `ProgramData` are out of scope.
- Verified with sandbox tests only (`bun test`, typecheck, lint, format). No real, non-dry run of the housekeeper was performed.
