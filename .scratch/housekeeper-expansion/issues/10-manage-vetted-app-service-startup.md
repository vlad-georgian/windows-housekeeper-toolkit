# 10: Manage vetted app service startup

Status: claimed
Type: task
Blocked by: 09

## What to build

Turn off automatic startup for individually vetted app-owned Windows services, then restore their original startup modes from the same confirmed workflow.

## Acceptance criteria

- [x] Only include services whose identity and app ownership can be verified. Show machine-wide scope and elevation requirements before confirmation.
- [x] Change a supported automatic service to Manual without stopping a running instance.
- [x] Save and restore the exact prior startup mode, including delayed automatic start when applicable. Recheck eligibility before applying or restoring a change.
- [ ] Verify disable and restore with a disposable or controlled service and confirm that cancelling leaves it unchanged.

## Comments

The launch-menu workflow checks the packaged Claude and Codex services. Read-only ACL inspection found that the installed Claude service lacks administrator configuration access, so the menu excludes it on this machine. The installed Codex service grants that access. In-process service fakes cover selection, cancellation, dry runs, identity changes, preserving a running instance, and restoring both automatic modes. The controlled Windows service acceptance check is reserved for the maintainer.
