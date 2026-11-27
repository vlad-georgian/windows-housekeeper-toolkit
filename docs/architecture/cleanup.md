# Cleanup workflows

Manual and sign-in runs share detection, deduplication, removal, and audit
summaries. Each entry point chooses the apps and decides what to display.
Each run holds the per-user lock while working with cleanup targets.

| File                                         | Responsibility                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`manual.ts`](../../src/cleanup/manual.ts)   | Parses flags, starts the audit, announces the scan, prompts for one or more apps, and prints a summary by drive. `--app` and `--all` bypass the prompt. |
| [`signin.ts`](../../src/cleanup/signin.ts)   | Loads sign-in settings, reapplies startup preferences if enabled, runs cleanup, and sends one notification with the audit log link.                     |
| [`scan.ts`](../../src/cleanup/scan.ts)       | Runs detection concurrently, records scan errors and sign-in skips, describes detections, and deduplicates overlapping targets.                         |
| [`remove.ts`](../../src/cleanup/remove.ts)   | Records candidates, prints dry-run details, applies the process guard, and records each removal as it happens.                                          |
| [`summary.ts`](../../src/cleanup/summary.ts) | Holds per-run totals and app outcomes, writes the final audit record, and sets a failing exit code when operations fail.                                |

Confirming the interactive prompt includes all verified candidates for each
checked app. Sign-in processes filesystem candidates for the saved app IDs.
Driver Store removal requires a manual run and elevation.
