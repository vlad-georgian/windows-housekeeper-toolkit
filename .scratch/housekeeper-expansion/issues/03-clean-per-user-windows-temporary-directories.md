# 03: Clean per-user Windows temporary directories

Status: ready-for-agent
Type: task
Blocked by: 02

## What to build

Offer allowlisted Windows temporary locations as the third cache checklist and as an explicit unattended cleanup category.

## Acceptance criteria

- [ ] List per-user Temp and the conventional per-user Temporary Internet Files cache after general and destructive cache cleanup.
- [ ] Attempt all eligible contents with no age cutoff. Skip locked or inaccessible entries and continue with siblings.
- [ ] Keep the root folders and avoid following links beyond their intended cleanup locations. Machine-wide Windows temporary folders are outside this category.
- [ ] Preview eligible targets and report skips. Verify on disposable Windows data that a locked file remains while an unlocked sibling is removed.
