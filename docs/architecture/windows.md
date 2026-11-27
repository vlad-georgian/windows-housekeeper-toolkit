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
| [`app-services/`](../../src/windows/app-services)                      | Verifies app-owned Windows services and manages reversible startup modes.                                                                         |
| [`app-updates/`](../../src/windows/app-updates)                        | Update inventory and verified App Installer controls.                                                                                             |
| [`migration/`](../../src/windows/migration)                            | Codex diagnostic migration, recovery, and reporting for other data locations.                                                                     |

## Startup

Startup status matches known installs to registry entries, Startup folders,
packaged startup tasks, and scheduled logon tasks. Disable and restore
operate on verified `HKCU Run` entries. The CLI saves the original entry
before removing it and records a pending restore before writing it back.

| File                                                             | Responsibility                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`index.ts`](../../src/windows/app-startup/index.ts)             | Console wrappers for startup disable, restore, and sign-in enforcement on the Windows backend. |
| [`manager.ts`](../../src/windows/app-startup/manager.ts)         | Shared disable, restore, and enforcement logic. The CLI and the launch menu both use it.       |
| [`backend.ts`](../../src/windows/app-startup/backend.ts)         | `StartupBackend`, the only way to read or write Windows startup entries. Tests inject a fake.  |
| [`inventory.ts`](../../src/windows/app-startup/inventory.ts)     | Reads startup locations and matches entries to installed executables.                          |
| [`preferences.ts`](../../src/windows/app-startup/preferences.ts) | Defines, validates, and persists preferences in `app-startup.json`.                            |
| [`registry.ts`](../../src/windows/app-startup/registry.ts)       | Verifies the executable and exact registry value before a change, then verifies the result.    |
| [`status.ts`](../../src/windows/app-startup/status.ts)           | Prints the startup and service inventory and opens Windows Startup settings.                   |

### Startup launch operation

The launch menu's **Manage automatic startup** operation lives in
[`src/startup/`](../../src/startup). A `StartupProvider` inspects one source
and returns checklist groups of `StartupChoice` values plus notes about
entries it will not change. Each choice states its plan lines and applies
itself. The operation owns prompting, the combined plan, dry runs, and
failure accounting. `createLaunchOperations` registers the sign-in and app
service providers.

| File                                                           | Responsibility                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`types.ts`](../../src/startup/types.ts)                       | Defines `StartupProvider`, `StartupGroup`, `StartupChoice`, and `StartupNote`.                             |
| [`operation.ts`](../../src/startup/operation.ts)               | Builds the launch operation from providers. A failed change is recorded and the rest still run.            |
| [`signin-provider.ts`](../../src/startup/signin-provider.ts)   | Offers verified HKCU Run entries to disable and saved preferences to restore. It reports other mechanisms. |
| [`service-provider.ts`](../../src/startup/service-provider.ts) | Offers vetted automatic Windows services to switch to Manual and saved startup modes to restore.           |

### App service startup

The service backend verifies the exact SCM service name, packaged service type,
account and image command against the enrolled package family, its service
declaration, and the expected signed executable. The saved preference binds the
package version, image command, and executable hash to the original mode.
Service selection also requires SCM configuration access. The backend rechecks
the Windows configuration after confirmation and again immediately before it
uses the same SCM handle to change the startup mode.

`app-service-startup.json` lives in the administrator profile's toolkit state.
A machine-wide toolkit lock covers verification, saving the original mode, and
each confirmed change. A confirmed pre-write rejection during disable removes
the record created by that attempt, allowing a newly verified installation to
be selected. An uncertain outcome retains the saved mode. A restore can resume
between the separate automatic and delayed-start updates. An identity mismatch
blocks restore and leaves the saved record in place.

Windows references for [packaged service declarations](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop6-service), [service configuration](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-changeserviceconfigw), and [delayed automatic start](https://learn.microsoft.com/en-us/windows/desktop/api/winsvc/ns-winsvc-service_delayed_auto_start_info).

## Updates

| File                                                                 | Responsibility                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`index.ts`](../../src/windows/app-updates/index.ts)                 | Reports installed update mechanisms and possible updater tasks, and chooses a unique verified package for `updates disable`.                                             |
| [`app-installer.ts`](../../src/windows/app-updates/app-installer.ts) | Reads package-specific settings, changes the background flag when Windows can preserve launch-time checks, and attempts to restore prior settings if verification fails. |

## Migration

The move journals the original file manifest and verifies the copy and
effective Codex redirect before reclaiming space. Rollback verifies the latest
destination files before restoring the original location. The saved phase and
manifests let a retry check which work has already completed.

| File                                                                       | Responsibility                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [`index.ts`](../../src/windows/migration/index.ts)                         | Routes migration status, move, resume, and rollback.                                                             |
| [`move.ts`](../../src/windows/migration/move.ts)                           | Validates a new destination and performs the copy, redirect, and reclaim phases.                                 |
| [`rollback.ts`](../../src/windows/migration/rollback.ts)                   | Restores the latest verified files and removes the operation-owned redirect.                                     |
| [`journal.ts`](../../src/windows/migration/journal.ts)                     | Validates `migration-codex-logs.json` and records phase changes.                                                 |
| [`snapshot.ts`](../../src/windows/migration/snapshot.ts)                   | Builds and verifies diagnostic file manifests, checks the SQLite bundle, and compares directory identities.      |
| [`files.ts`](../../src/windows/migration/files.ts)                         | Checks local files, capacity, alternate data streams, and hashes, and copies or removes verified files.          |
| [`codex-config.ts`](../../src/windows/migration/codex-config.ts)           | Reads TOML, checks profile overrides, and updates the operation-owned `log_dir` while preserving other settings. |
| [`codex-environment.ts`](../../src/windows/migration/codex-environment.ts) | Checks running Codex processes, environment overrides, executable support, and managed requirements.             |
| [`status.ts`](../../src/windows/migration/status.ts)                       | Reports migration state, other detected data paths, existing redirects, and available space on E: when present.  |
