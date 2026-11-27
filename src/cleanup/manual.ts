import * as p from "@clack/prompts";
import pc from "picocolors";

import { AuditLogger } from "../core/audit-logger.ts";
import { parseCliOptions } from "../core/cli-options.ts";
import { projectName, withRunLock } from "../core/state.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import type { AppCleaner } from "../core/types.ts";
import { runLaunchMenu } from "../launch/menu.ts";
import { createLaunchOperations } from "../launch/operations.ts";
import { clackPrompts } from "../launch/prompts.ts";
import { cleanersForCategories } from "./categories.ts";
import { type CleanupSession, runUnattendedCleanup } from "./operations.ts";
import { describeSummary, finishAudit, newSummary } from "./summary.ts";

/**
 * Runs the interactive launch menu, or an unattended cleanup when categories are named.
 * Destructive caches and old installations run unattended only when their category is named.
 */
export async function runManualCleanup(
    paths: SystemPaths,
    cleaners: readonly AppCleaner[],
    args: readonly string[],
): Promise<void> {
    const options = parseCliOptions(args);
    p.intro(pc.bgCyan(pc.black(` ${projectName} `)));
    await withRunLock(paths, async () => {
        const session: CleanupSession = {
            audit: await AuditLogger.create(options.logDirectory),
            summary: newSummary(),
            dryRun: options.dryRun,
            selectedCleaners: new Set(),
        };

        if (options.categories.length > 0) {
            const selected = cleanersForCategories(cleaners, options.categories);
            p.log.step(`Scanning ${selected.length} cleaners in ${options.categories.join(", ")}…`);
            await runUnattendedCleanup(selected, session);
        } else {
            const operations = createLaunchOperations({ paths, cleaners, cleanup: session });
            const outcome = await runLaunchMenu(operations, clackPrompts, {
                dryRun: options.dryRun,
            });
            if (outcome !== "applied" && outcome !== "previewed") {
                await finishAudit(session.audit, session.summary, options.dryRun, []);
                const reason =
                    outcome === "nothing-selected" ? "Nothing selected." : "Plan not applied.";
                p.outro(`${reason} No files were removed. Audit log at ${session.audit.path}`);
                return;
            }
        }

        await finishAudit(session.audit, session.summary, options.dryRun, [
            ...session.selectedCleaners,
        ]);
        p.note(
            describeSummary(session.summary, options.dryRun, session.audit.path).join("\n"),
            "Summary",
        );
        p.outro(
            session.summary.failures ? pc.yellow("Finished with warnings") : pc.green("Finished"),
        );
    });
}
