# 08: Relocate package managers and their runtimes

Status: resolved
Type: task
Blocked by: 07

## What to build

Offer reversible relocation of verified per-user Node.js, Vite+, Bun, npm, Scoop, and Chocolatey installation or package paths.

## Acceptance criteria

- [x] A verified standalone per-user Node.js installation can move independently. A Node.js runtime bundled with Scoop or Vite+ moves with its owner.
- [x] Support npm and Bun global package paths and their applicable per-user data. Manager-owned app copies move with the manager and keep expected launchers usable.
- [x] Support verified per-user Scoop and Chocolatey paths. Machine-wide Chocolatey packages stay outside the relocation catalog.
- [x] Preview overlapping paths once, preserve links into persistent package data, and verify that selecting multiple related entries cannot move or restore a physical tree twice.
- [x] Demonstrate relocation and restoration of a package layout with a shared persistent path, using disposable Windows data.

## Answer

The [relocation architecture](../../../docs/architecture/relocation.md#package-manager-ownership)
records the evidence required for each package path. The Windows Scoop
fixture uses two version directories that link to one persistent directory,
selects overlapping catalog entries, and verifies one transfer each way.
It checks that the persistent directory retains its identity and every
consumer can read the latest data. The other fixtures cover an independent
Node.js move, Vite+-managed Node.js, npm and Bun global packages, per-user
Chocolatey, and a conflict between distinct names for the same backing tree.
