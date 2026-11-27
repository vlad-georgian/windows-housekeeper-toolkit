# Architecture

The Bun entry point resolves Windows paths, builds the cleaner catalog, and
routes commands to cleanup or a Windows feature. Cleanup uses each cleaner's
`detect` and `remove` methods. The shared filesystem code verifies a
candidate's location and identity before removing it. Windows feature modules
use PowerShell, Windows tools, or the installed app to query and verify system
state.

| Path                                 | Role                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| [`src/index.ts`](../../src/index.ts) | Windows platform check, command dispatch, locking for Windows control commands, and top-level error reporting. |
| [`src/launch/`](cleanup.md)          | Launch menu, operation registry, combined plan, and prompt adapter.                                            |
| [`src/cleanup/`](cleanup.md)         | Cleanup categories and operations, unattended and sign-in cleanup, from detection through the audit summary.   |
| [`src/cleaners/`](cleaners.md)       | App-specific rules for recognizing and removing redundant payloads.                                            |
| [`src/core/`](core.md)               | Shared types, filesystem verification, state, command execution, and formatting.                               |
| [`src/windows/`](windows.md)         | Startup, updates, scheduled tasks, notifications, process inspection, and migration.                           |

The launch menu (`src/launch/`) starts with every operation unchecked. Each
selected operation gathers its own choices, then one combined plan is
confirmed before anything is applied. Cleanup operations scan their cleanup
categories before showing each checklist so it can show counts and estimated
bytes, and deduplicate overlapping paths before preview or removal. Naming
`--category` runs those categories unattended instead. Sign-in cleanup runs
only general cache cleaners from the saved IDs and checks for active
processes during scanning and before removal.

State lives under `%LOCALAPPDATA%\windows-housekeeper-toolkit`. A named-pipe lock
scoped to that directory serializes operations. State writes use a temporary
file and rename, and the migration journal records phases for resume and
rollback.
