# 08: Relocate package managers and their runtimes

Status: ready-for-agent
Type: task
Blocked by: 07

## What to build

Offer reversible relocation of verified per-user Node.js, Vite+, Bun, npm, Scoop, and Chocolatey installation or package paths.

## Acceptance criteria

- [ ] A verified standalone per-user Node.js installation can move independently. A Node.js runtime bundled with Scoop or Vite+ moves with its owner.
- [ ] Support npm and Bun global package paths and their applicable per-user data. Manager-owned app copies move with the manager and keep expected launchers usable.
- [ ] Support verified per-user Scoop and Chocolatey paths. Machine-wide Chocolatey packages stay outside the relocation catalog.
- [ ] Preview overlapping paths once, preserve links into persistent package data, and verify that selecting multiple related entries cannot move or restore a physical tree twice.
- [ ] Demonstrate relocation and restoration of a package layout with a shared persistent path, using disposable Windows data.
