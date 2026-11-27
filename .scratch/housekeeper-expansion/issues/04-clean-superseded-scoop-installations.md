# 04: Clean verified superseded Scoop installations

Status: ready-for-agent
Type: task
Blocked by: 02

## What to build

Offer verified, superseded per-user Scoop installations in the old-installation checklist, including Scoop-managed Node.js.

## Acceptance criteria

- [ ] Determine the selected version and confirm each older candidate from Scoop's installation layout and metadata. Skip ambiguous or incomplete releases.
- [ ] Protect current or in-use versions, intentionally retained versions where identified, and Scoop's shared persistent data. Removing an old Node.js version leaves the shared `bin` and `cache` targets usable.
- [ ] Recheck the version selection and in-use status before removal. Verify on disposable Scoop-shaped data that old versions are removed and current and persistent data survive.
