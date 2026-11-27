import { AuditLogger } from "../core/audit-logger.ts";
import { formatBytes } from "../core/format.ts";
import { projectName, withRunLock } from "../core/state.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import type { AppCleaner } from "../core/types.ts";
import { reapplyStartupPreferences } from "../windows/app-startup/index.ts";
import { sendCleanupNotification } from "../windows/notification.ts";
import { readSignInSettings, signInLogDirectory } from "../windows/signin.ts";
import { resolveSignInCleaners } from "./categories.ts";
import { runCleanup } from "./remove.ts";
import { deduplicate, scan } from "./scan.ts";
import { finishAudit, newSummary } from "./summary.ts";

export async function runAtSignIn(
    paths: SystemPaths,
    cleaners: readonly AppCleaner[],
): Promise<void> {
    const initial = await readSignInSettings(paths);
    if (!initial.cleanupEnabled && !initial.enforcementEnabled) return;
    const audit = await AuditLogger.create(signInLogDirectory(paths));
    const summary = newSummary();
    let notify = initial.cleanupEnabled;
    let selectedApps = initial.cleanupApps;
    try {
        await withRunLock(paths, async () => {
            const saved = await readSignInSettings(paths);
            notify = saved.cleanupEnabled;
            selectedApps = saved.cleanupApps;
            if (saved.enforcementEnabled) {
                try {
                    const { messages, failures } = await reapplyStartupPreferences(paths);
                    summary.failures += failures;
                    if (failures) summary.failedApps.add("startup preferences");
                    await audit.recordStartupEnforcement(messages, failures);
                } catch (error) {
                    summary.failures += 1;
                    summary.failedApps.add("startup preferences");
                    await audit.recordError("signin", projectName, null, error);
                }
            }
            if (saved.cleanupEnabled) {
                // Sign-in runs only general cache cleanup. Other saved selections are excluded.
                const { cleaners: selected, excluded } = resolveSignInCleaners(
                    cleaners,
                    selectedApps,
                );
                for (const id of excluded) {
                    await audit.recordSkip(id, "Excluded from sign-in: not general cache cleanup");
                }
                const detections = await scan(selected, audit, summary, true);
                await runCleanup(deduplicate(detections), audit, summary, {
                    dryRun: false,
                    signIn: true,
                });
            }
        });
    } catch (error) {
        summary.failures += 1;
        summary.failedApps.add("sign-in job");
        await audit.recordError("signin", projectName, null, error);
    }

    await finishAudit(audit, summary, false, notify ? selectedApps : []);
    if (notify) {
        const cleaned = [...summary.cleanedApps].join(", ");
        const result = cleaned ? `Cleaned ${cleaned}` : "Nothing cleaned";
        const skipped = summary.skippedApps.size
            ? `. ${summary.skippedApps.size} running app(s) skipped`
            : "";
        const failures = summary.failures
            ? `${summary.failures} failure(s) in ${[...summary.failedApps].join(", ")}`
            : "No failures";
        const message = `${result}. ${formatBytes(summary.reclaimedBytes)} reclaimed. ${failures}${skipped}.`;
        try {
            await sendCleanupNotification(message, audit.path);
        } catch (error) {
            process.exitCode = 1;
            await audit.recordError("notification", projectName, null, error);
        }
    }
}
