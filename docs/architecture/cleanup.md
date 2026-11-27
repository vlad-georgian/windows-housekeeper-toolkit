# Cleanup workflows

Interactive, unattended, and sign-in runs share detection, deduplication,
removal, and audit summaries. Each run holds the per-user lock while working
with cleanup targets.

## Launch menu

| File                                              | Responsibility                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`types.ts`](../../src/launch/types.ts)           | Defines `LaunchOperation`, `PlanSection`, the `LaunchPrompts` surface, and the `cancelled` result.                               |
| [`menu.ts`](../../src/launch/menu.ts)             | Shows the unchecked operation menu, gathers each selected operation, shows one combined plan, and applies it after confirmation. |
| [`operations.ts`](../../src/launch/operations.ts) | Lists the launch operations in menu order. New operations implement `LaunchOperation` in their own module and are added here.    |
| [`prompts.ts`](../../src/launch/prompts.ts)       | Adapts Clack prompts. Checklists accept an empty selection, and **A** toggles all.                                               |

Cancelling any prompt leaves the plan unapplied. A dry run shows the plan and
previews each target without asking for confirmation.

## Cleanup

| File                                               | Responsibility                                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`categories.ts`](../../src/cleanup/categories.ts) | Registers cleanup categories in checklist order with their operation and sign-in eligibility, and selects cleaners for unattended and sign-in runs. |
| [`operations.ts`](../../src/cleanup/operations.ts) | Builds the cache and old-installation launch operations, one checklist per category, and runs unattended cleanup for named categories.              |
| [`manual.ts`](../../src/cleanup/manual.ts)         | Parses flags, starts the audit, runs the launch menu or the named categories, and prints a summary by drive.                                        |
| [`signin.ts`](../../src/cleanup/signin.ts)         | Loads sign-in settings, reapplies startup preferences if enabled, runs general cache cleanup, and sends one notification with the audit log link.   |
| [`scan.ts`](../../src/cleanup/scan.ts)             | Runs detection concurrently, records scan errors and sign-in skips, describes detections, and deduplicates overlapping targets.                     |
| [`remove.ts`](../../src/cleanup/remove.ts)         | Records candidates, prints dry-run details, applies the running-app check, and records each removal as it happens.                                  |
| [`summary.ts`](../../src/cleanup/summary.ts)       | Holds per-run totals and app outcomes, writes the final audit record, describes the summary, and sets a failing exit code when operations fail.     |

Cache cleanup shows the general cache checklist, then the package-cache
checklist for destructive cache cleanup. Every item starts unchecked, including
after toggling all launch operations. Checking an app includes all of its
verified candidates in that category.

Unattended runs need explicit `--category` names, and destructive caches run
only when `destructive-cache` is named. Sign-in runs only general cache
cleanup. Saved selections in other categories are excluded and recorded in the
audit log. Driver Store removal requires a manual run and elevation.
