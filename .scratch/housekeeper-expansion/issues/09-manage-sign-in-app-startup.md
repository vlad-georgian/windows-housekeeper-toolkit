# 09: Manage app startup from the launch menu

Status: resolved
Type: task
Blocked by: 02

## What to build

Select verified app sign-in entries from the launch menu, confirm the changes, and restore the saved prior settings using the same workflow.

## Acceptance criteria

- [x] Show allowlisted, verified entries and distinguish changes to the current user's sign-in from other startup mechanisms.
- [x] Preview the exact entries to disable or restore in the combined plan. Confirmation applies only the selected changes.
- [x] Restore prior entries using the existing app startup preferences. Keep automatic preference enforcement independently configurable.
- [x] Verify selection, cancellation, disable, and restore with safe test entries.

## Comments

Resolved on branch `ticket/09-sign-in-startup`.

- The launch menu now offers **Manage automatic startup** (`startup`), built by `createStartupOperation` in `src/startup/operation.ts` and registered in `createLaunchOperations`.
- **Seam for ticket 10:** a `StartupProvider` (`src/startup/types.ts`) inspects one source and returns `StartupGroup`s (one unchecked checklist each) of `StartupChoice`s, plus `StartupNote`s for entries it will not change. A choice carries its exact `planLines` and its own `apply()`. The operation owns prompting, the combined plan, dry runs, and failures (a failed choice increments `summary.failures`, adds `startup` to `failedApps`, writes an audit error, and the remaining choices still run). Add a service provider with its own groups (put the machine-wide scope and elevation requirement in the group `title`, `message`, and choice `hint`/`planLines`) and add it to the default list in `createLaunchOperations` (`LaunchContext.startup` overrides it in tests).
- **Windows access seam:** `StartupBackend` (`src/windows/app-startup/backend.ts`) is the only way to read or write startup entries. `createSystemStartupBackend` reads the app inventory lazily. Tests use `FakeStartupBackend` (`src/test-support/fake-startup-backend.ts`), an in-memory HKCU Run key; nothing touches the real registry, Startup folder, or scheduled tasks. Ticket 10 will likely want a similar injectable backend for service control.
- The disable/restore/enforcement logic moved from `app-startup/index.ts` into `manager.ts` and returns messages instead of printing. The `startup disable|restore` CLI commands and the menu share it, so they use the same saved preferences (`app-startup.json`).
- The menu never reads or writes `signin.json`, so startup preference enforcement stays independently configurable. After a menu restore the preference is forgotten, so enforcement does not disable it again.
- Other mechanisms (machine-wide Run, RunOnce, Startup folders, scheduled logon tasks, packaged startup tasks) and inspection warnings appear in a "not changed here" note, never as choices.
- Decision: two checklists (turn off, restore) rather than one toggle list, so every choice means "change this" and nothing is pre-checked.
- No real (non-dry) run was performed against the machine; verification uses fakes and sandboxes only.
