# 10: Manage vetted app service startup

Status: ready-for-agent
Type: task
Blocked by: 09

## What to build

Turn off automatic startup for individually vetted app-owned Windows services, then restore their original startup modes from the same confirmed workflow.

## Acceptance criteria

- [ ] Only include services whose identity and app ownership can be verified. Show machine-wide scope and elevation requirements before confirmation.
- [ ] Change a supported automatic service to Manual without stopping a running instance.
- [ ] Save and restore the exact prior startup mode, including delayed automatic start when applicable. Recheck eligibility before applying or restoring a change.
- [ ] Verify disable and restore with a disposable or controlled service and confirm that cancelling leaves it unchanged.
