# 05: Clean verified old Vite+, Claude Code, and VS Code data

Status: ready-for-agent
Type: task
Blocked by: 02

## What to build

Add per-user obsolete Vite+ releases, native Claude Code versions, and obsolete VS Code extensions to the old-installation operation.

## Acceptance criteria

- [ ] Verify Vite+'s active release and any recorded fallback, and preserve both.
- [ ] Identify the active native Claude Code version using the native installation, even if a different launcher comes first on `PATH`. Only verified superseded native versions qualify.
- [ ] Offer VS Code extension directories only when the app's metadata explicitly identifies them as obsolete. Preserve installed extensions that remain in use.
- [ ] Revalidate the metadata before removal and demonstrate each candidate type and each protected version in a dry run or disposable fixture.
