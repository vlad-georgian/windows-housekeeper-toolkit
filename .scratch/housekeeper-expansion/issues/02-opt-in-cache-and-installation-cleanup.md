# 02: Make cache and old-installation cleanup opt-in

Status: ready-for-agent
Type: task
Blocked by: None (can start immediately)

## What to build

Run general caches, destructive caches, and old-installation cleanup from one opt-in CLI workflow. Let the user select supported apps interactively or name a cleanup category for an unattended run.

## Acceptance criteria

- [ ] The launch menu starts unchecked and supports `A` to toggle all available operations. Gather selections before showing one combined plan. Cancelling any prompt leaves the plan unapplied.
- [ ] Cache cleanup first presents regenerable caches for allowlisted apps such as Codex, Claude, Discord, and GitHub Desktop, then a separate package-cache checklist. All destructive-cache items start unchecked, including after toggling all top-level operations.
- [ ] Support verified per-user package download caches for npm, Bun, Scoop, Chocolatey, and NuGet where present. Show the redownload and offline-use implications. Preserve installed packages and stores that current projects use.
- [ ] The old-installation operation covers verified per-user Codex standalone and daemon releases and existing desktop app coverage, including GitHub Desktop. Keep cache cleaners and old-installation cleaners separate, with one app file per applicable operation.
- [ ] Apply latest-only Codex cleanup independently per release store. An older recorded rollback version may qualify after verification. Preserve the selected release, releases in use, and staged newer releases. Preserve explicitly recorded fallbacks for other apps and installed or pending updates.
- [ ] Replace `--all` and `--app` with explicit cleanup categories. Destructive caches run unattended only when their category is named. Dry runs show eligible targets without removing them, and completed runs retain audit summaries.
- [ ] Preserve enabled sign-in cleanup and saved selections that map to general cache cleanup. Exclude other cleanup categories from sign-in and keep startup preference enforcement independently configurable.
- [ ] Verify interactive cancellation, a dry run for each category, and that the sign-in job never selects destructive caches or installations.
