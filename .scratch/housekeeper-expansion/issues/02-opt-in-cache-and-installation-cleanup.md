# 02: Make cache and old-installation cleanup opt-in

Status: resolved
Type: task
Blocked by: None (can start immediately)

## What to build

Run general caches, destructive caches, and old-installation cleanup from one opt-in CLI workflow. Let the user select supported apps interactively or name a cleanup category for an unattended run.

## Acceptance criteria

- [x] The launch menu starts unchecked and supports `A` to toggle all available operations. Gather selections before showing one combined plan. Cancelling any prompt leaves the plan unapplied.
- [x] Cache cleanup first presents regenerable caches for allowlisted apps such as Codex, Claude, Discord, and GitHub Desktop, then a separate package-cache checklist. All destructive-cache items start unchecked, including after toggling all top-level operations.
- [x] Support verified per-user package download caches for npm, Bun, Scoop, Chocolatey, and NuGet where present. Show the redownload and offline-use implications. Preserve installed packages and stores that current projects use.
- [x] The old-installation operation covers verified per-user Codex standalone and daemon releases and existing desktop app coverage, including GitHub Desktop. Keep cache cleaners and old-installation cleaners separate, with one app file per applicable operation.
- [x] Apply latest-only Codex cleanup independently per release store. An older recorded rollback version may qualify after verification. Preserve the selected release, releases in use, and staged newer releases. Preserve explicitly recorded fallbacks for other apps and installed or pending updates.
- [x] Replace `--all` and `--app` with explicit cleanup categories. Destructive caches run unattended only when their category is named. Dry runs show eligible targets without removing them, and completed runs retain audit summaries.
- [x] Preserve enabled sign-in cleanup and saved selections that map to general cache cleanup. Exclude other cleanup categories from sign-in and keep startup preference enforcement independently configurable.
- [x] Verify interactive cancellation, a dry run for each category, and that the sign-in job never selects destructive caches or installations.

## Comments

Resolved on branch `ticket/02-opt-in-cleanup`.

- The launch menu (`src/launch/`) starts unchecked and supports **A**. Each selected `LaunchOperation` gathers its own choices, then one combined plan is confirmed. Cancelling any prompt, including the confirmation, applies nothing. A dry run previews the plan without confirmation.
- Cleanup categories (`general-cache`, `destructive-cache`, `old-installations`) are registered in `src/cleanup/categories.ts`. Cleaners live in `src/cleaners/cache/`, `package-cache/`, and `installations/`, one file per app per operation, each registered in its folder's `index.ts`.
- New cleaners cover Discord and GitHub Desktop caches and the Bun, Scoop, and Chocolatey package caches. They use the IDs `discord-cache` and `github-desktop-cache` so saved old-version sign-in selections are not repurposed.
- Codex keeps only the selected release and any staged update in each store. The recorded previous release qualifies after verification. Updater cleaners no longer offer `pending/` payloads.
- `--all` and `--app` are replaced by repeatable `--category`. Sign-in runs only general cache cleanup. Other saved IDs are excluded at run time and recorded in the audit log.
- Verification: `bun test` (38 tests on disposable sandboxes, including cancellation, a dry run per category, and sign-in selection), typecheck, and lint pass. Real dry runs of each category on the development machine removed nothing.
- Open question: the NVIDIA driver and AMD installer cleaners target machine-wide locations, but the spec limits old-installation cleanup to per-user targets. They remain in `old-installations` as existing coverage, pending a decision.
