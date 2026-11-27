# Windows integrations

| File or directory                                                      | Responsibility                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`app-controls.ts`](../../src/windows/app-controls.ts)                 | Routes startup and update commands and validates app IDs and arguments.                                                                           |
| [`app-catalog.ts`](../../src/windows/app-catalog.ts)                   | Lists known app IDs, executable locations, and package identities. It validates inventory results and shares a Task Scheduler enumeration script. |
| [`app-inventory-script.ts`](../../src/windows/app-inventory-script.ts) | Queries Windows for installed executables, package manifests, packaged startup tasks, and services tied to known apps.                            |
| [`powershell.ts`](../../src/windows/powershell.ts)                     | Runs Windows PowerShell with UTF-8 JSON input, captured output, optional timeouts, and a hidden child window.                                     |
| [`processes.ts`](../../src/windows/processes.ts)                       | Reads Windows processes and maps known names and executable paths to cleaner IDs.                                                                 |
| [`signin.ts`](../../src/windows/signin.ts)                             | Validates sign-in settings and cleaner eligibility. It inspects, registers, or removes the per-user task.                                         |
| [`notification.ts`](../../src/windows/notification.ts)                 | Registers the notification identity, sends the Windows toast, and verifies the audit log path before opening it.                                  |
| [`app-startup/`](../../src/windows/app-startup)                        | Startup inventory and reversible per-user preferences.                                                                                            |
| [`app-updates/`](../../src/windows/app-updates)                        | Update inventory and verified App Installer controls.                                                                                             |

## Startup

Startup status matches known installs to registry entries, Startup folders,
packaged startup tasks, and scheduled logon tasks. Disable and restore
operate on verified `HKCU Run` entries. The CLI saves the original entry
before removing it and records a pending restore before writing it back.

| File                                                             | Responsibility                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`index.ts`](../../src/windows/app-startup/index.ts)             | Implements startup disable, restore, and sign-in enforcement.                               |
| [`inventory.ts`](../../src/windows/app-startup/inventory.ts)     | Reads startup locations and matches entries to installed executables.                       |
| [`preferences.ts`](../../src/windows/app-startup/preferences.ts) | Defines, validates, and persists preferences in `app-startup.json`.                         |
| [`registry.ts`](../../src/windows/app-startup/registry.ts)       | Verifies the executable and exact registry value before a change, then verifies the result. |
| [`status.ts`](../../src/windows/app-startup/status.ts)           | Prints the startup and service inventory and opens Windows Startup settings.                |

## Updates

| File                                                                 | Responsibility                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`index.ts`](../../src/windows/app-updates/index.ts)                 | Reports installed update mechanisms and possible updater tasks, and chooses a unique verified package for `updates disable`.                                             |
| [`app-installer.ts`](../../src/windows/app-updates/app-installer.ts) | Reads package-specific settings, changes the background flag when Windows can preserve launch-time checks, and attempts to restore prior settings if verification fails. |
