# windows-housekeeper-toolkit

## Problem Statement

The Windows cleanup CLI targets a fixed catalog of app versions and updater files. That catalog misses some space consumers on this machine and assumes installation paths that can vary by package manager or app version. I want to recover disk space without putting my worktrees, conversations, generated files, or other user data at risk.

I also want control over which apps launch when I sign in and which can update while closed. I want the option to run cleanup at sign-in and see the result in a Windows notification. For files that make sense to keep on another drive, I want a move that frees space and can be reversed.

## Solution

Rename the project and its workspace folder to `windows-housekeeper-toolkit`. Refresh the cleanup catalog using evidence from installed apps, and retain the interactive CLI, dry runs, and audit logs. Use Vite+ for development commands and pin Bun as the package manager and CLI runtime. Remove the automated test suite.

Add reversible app startup controls and manage verified background update mechanisms for Codex, Claude, T3 Code, and OpenCode by installation type. Give sign-in cleanup and startup preference enforcement independent switches. Sign-in cleanup runs for a selected set of apps and posts one Windows notification per run.

Offer reversible application relocation for verified per-user installation and data paths. Keep protected data in place. Verify the copy and the links at the original paths before reclaiming space, and restore from the latest destination copy.

## User Stories

1. As the project owner, I want the package, CLI command, display name, audit-log prefix, and workspace folder to use the new name, so that I can recognize the project wherever I use it.
2. As the project owner, I want Vite+ to run the development workflow, so that installation, formatting, linting, and static checks use one toolchain.
3. As the project owner, I want the project to select a pinned Bun version, so that Vite+ uses Bun by default and the CLI keeps its Bun runtime.
4. As the project owner, I want the automated test suite and its commands removed, so that the development workflow reflects the checks I intend to maintain.
5. As a Windows user, I want a dry run to show each cleanup candidate and its reason, so that I can review the proposed removals before cleanup.
6. As a Windows user, I want the app catalog refreshed against software installed on my machine, so that the CLI can find relevant files that it currently misses.
7. As a Windows user, I want existing cleaners to recognize verified alternate installation paths, so that cleanup can account for apps installed through different channels.
8. As a Windows user, I want the Codex cleaner to recognize the verified Scoop installation, so that it can inspect the npm location my CLI actually uses.
9. As a Windows user, I want old Codex standalone and app-server daemon releases assessed independently, so that each active version is preserved.
10. As a Windows user, I want verified OpenCode Desktop updater files and VS Code caches included in the catalog, so that I can reclaim space from those apps.
11. As a Windows user, I want settings, conversations, worktrees, and generated files protected during cleanup, so that I can resume my work afterward.
12. As a Windows user, I want redirected and aliased paths recognized, so that the CLI attributes space to the correct drive and counts a file once.
13. As a Windows user, I want an audit log of cleanup results and failures, so that I can see what happened to each target.
14. As a Windows user, I want to inspect startup entries for Codex, Claude, T3 Code, and OpenCode, so that I know which installed variants can launch automatically.
15. As a Windows user, I want to disable a verified startup entry for a specific app, so that I can choose when to launch it.
16. As a Windows user, I want to reverse a startup change, so that I can restore the previous behavior.
17. As a Windows user, I want guidance for packaged startup entries that Windows requires me to change in Settings, so that I can make those changes through Windows.
18. As a Windows user, I want separate reporting for app services, so that I can distinguish them from apps that open at sign-in.
19. As a Windows user, I want to save my app startup preferences and reapply them at sign-in, so that supported entries reflect my choices across sessions.
20. As a Windows user, I want startup preference enforcement and sign-in cleanup to have separate switches, so that I can enable either independently.
21. As a Windows user, I want to inspect how each supported app variant updates, so that I can distinguish updates during app use from mechanisms that run while it is closed.
22. As a Windows user, I want to disable a verified app-specific background update mechanism, so that the app can still update when I run it.
23. As a Windows user, I want the CLI to report when an install has only an all-or-nothing update setting or an unverified mechanism, so that I know the limit of the available control.
24. As a Windows user, I want to enable and disable cleanup at my Windows sign-in, so that I can choose when unattended cleanup runs.
25. As a Windows user, I want to pick the apps included in sign-in cleanup, so that the job runs only for the apps I selected.
26. As a Windows user, I want sign-in cleanup to skip apps that are running, so that it avoids files the apps may be using.
27. As a Windows user, I want administrator-only driver removal available through a manual run, so that I can choose when to run it with elevation.
28. As a Windows user, I want one notification after every sign-in cleanup, including an empty run, so that I know the job finished.
29. As a Windows user, I want the notification to show which apps were cleaned, the space reclaimed, and any failures, so that I can understand the result at a glance.
30. As a Windows user, I want the notification to link to the audit log, so that I can inspect the full result.
31. As a Windows user, I want the checklist to show which applications are available for relocation and which are already migrated, so that I can decide what is worth moving.
32. As a Windows user, I want to select a relocation base for the apps I move, so that I can decide where to use the available disk space.
33. As a Windows user, I want only verified per-user app paths to be relocated, with links at the original locations so the app can keep using those paths.
34. As a Windows user, I want the move to verify the copy and each link before reclaiming source space, so that the files remain usable after the command completes.
35. As a Windows user, I want a successful move to reclaim source space in the same command, so that I get the disk-space benefit immediately.
36. As a Windows user, I want to roll back a move using the latest destination files, so that I can restore the original location without losing subsequent changes.
37. As a Windows user, I want worktrees, conversations, generated outputs, and other protected data to stay in place during relocation, so that existing projects and sessions keep working.

## Implementation Decisions

- Rename the package, command, display name, audit-log prefix, and workspace folder. Keep the project a Windows CLI. Use Vite+ for installs, development commands, formatting, linting, and static checks. Use a project-level Bun pin and run the CLI with Bun.
- Extend the existing cleaner catalog and reuse its detection, dry-run, removal, and audit flow. Retain manual interactive and command-line cleanup. Check existing targets against the installed variants and add only verified, narrowly scoped cleanup candidates.
- Verify the active selection for each Codex release store separately. Preserve active and in-use versions and skip a version store if its active selection is ambiguous. Verify alternate npm locations before considering updater remnants. Inspect the OpenCode Desktop updater root and add only verified redundant files. Limit VS Code cleanup to verified regenerable caches.
- Verify the resolved identity of cleanup and relocation targets, including linked ancestors, before measuring or mutating them. Count aliases once and attribute any savings to the drive where files are stored. Preserve active installs, settings, authentication, installed plugins, and protected data during cleanup. Skip ambiguous paths.
- Manage verified app startup entries reversibly, with a way to restore the previous state. Store the user's app startup preferences for optional startup preference enforcement. Report packaged entries that require Windows Settings and guide the user there. Report app services for information and preserve their configuration.
- Detect background update mechanisms by app and installation type. Apply a change only when the verified, app-specific control preserves updates while the app runs. Report all-or-nothing settings, unsupported mechanisms, and unverified mechanisms as such.
- Run sign-in cleanup and startup preference enforcement in the user's Windows session. Give each its own on/off switch. Use an explicit app list for unattended cleanup, skip running apps, and reserve administrator-only driver removal for manual runs.
- Send one Windows notification when each sign-in cleanup finishes, including runs that find nothing. Include the apps cleaned, reclaimed space, failures when present, and access to the detailed audit log.
- Follow the [application relocation decision](../adr/0002-relocate-applications-with-directory-junctions.md). Mirror eligible per-user paths under the selected relocation base and the Windows profile name. Keep the original directory paths usable through junctions. Report destination conflicts and running applications before any data changes.
- Verify the copy, permissions, and junction before reclaiming source space. Keep recovery records for interrupted transfers. Restore the latest contents at the original paths and verify them before reclaiming destination space. See the [expansion spec](../../.scratch/housekeeper-expansion/spec.md) for the relocation catalog and scope.

## Testing Decisions

- Remove the existing automated tests and their entry points. Keep formatting, linting, and static checks in the development workflow.
- Verify behavior through the CLI and Windows surfaces the user interacts with. Check that dry runs report the intended candidates, that verified startup preferences can be restored, and that sign-in settings operate independently.
- Use disposable data for checks that require deletion, relocation, or restore. Verify that protected data stays in its original location and that failed relocation verification preserves the source. Verify that the sign-in notification reports empty runs, removals, and failures and provides access to the audit log.

## Out of Scope

- Cleanup or relocation of worktrees, project files, conversations, generated outputs, credentials, and other protected data.
- Moving whole profiles that include protected data.
- Changes to Windows service startup, system-wide update policy, and update settings that would also suppress updates while an app runs.
- Cleanup before Windows sign-in or unattended administrator-only driver removal.
- A replacement automated test suite.

## Further Notes

- The inventory found approximately 5.4 GiB across older Codex standalone and daemon releases and about 950 MiB in VS Code caches. Those are observed sizes. Actual reclaimable space depends on the checks for active releases, running apps, and file ownership.
- Claude Desktop's package data already resolves to E:. The existing redirect is relevant to drive accounting. T3 Code's worktrees are protected data.
- The OpenCode Desktop updater root was present. Some updater contents and scheduled tasks were inaccessible during inventory, so their payloads and behavior require verification before they can be managed.
- The [glossary](../../GLOSSARY.md) defines the terms used in this spec.
