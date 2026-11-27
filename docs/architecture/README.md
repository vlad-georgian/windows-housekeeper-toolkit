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
| [`src/cleanup/`](cleanup.md)         | Manual and sign-in cleanup, from detection through the audit summary.                                          |
| [`src/cleaners/`](cleaners.md)       | App-specific rules for recognizing and removing redundant payloads.                                            |
| [`src/core/`](core.md)               | Shared types, filesystem verification, state, command execution, and formatting.                               |
| [`src/windows/`](windows.md)         | Startup, updates, scheduled tasks, notifications, process inspection, and migration.                           |

Manual cleanup scans the requested apps before prompting so the menu can
show counts and estimated bytes. It filters detections to the chosen app IDs
and deduplicates overlapping paths before preview or removal. Sign-in cleanup
uses saved app IDs and checks for active processes during scanning and before
removal.

State lives under `%LOCALAPPDATA%\windows-housekeeper-toolkit`. A named-pipe lock
scoped to that directory serializes operations. State writes use a temporary
file and rename, and the migration journal records phases for resume and
rollback.
