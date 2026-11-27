import { parse } from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { AuditLogger } from "../core/audit-logger.ts";
import { parseCliOptions } from "../core/cli-options.ts";
import { formatBytes, sumKnownBytes } from "../core/format.ts";
import { projectName, withRunLock } from "../core/state.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import type { AppCleaner, DetectionResult } from "../core/types.ts";
import { runCleanup } from "./remove.ts";
import { deduplicate, optionHint, scan } from "./scan.ts";
import { finishAudit, newSummary } from "./summary.ts";

async function chooseResults(
    results: readonly DetectionResult[],
): Promise<readonly DetectionResult[] | null> {
    if (results.length === 0) return [];
    const answer = await p.multiselect({
        message: "Which applications should be cleaned? Press A to toggle all.",
        options: results.map((result) => ({
            value: result.cleaner.id,
            label: result.cleaner.label,
            hint: optionHint(result),
        })),
    });
    if (p.isCancel(answer)) return null;

    const selectedIds = new Set(answer);
    return results.filter((result) => selectedIds.has(result.cleaner.id));
}

export async function runManualCleanup(
    paths: SystemPaths,
    cleaners: readonly AppCleaner[],
    args: readonly string[],
): Promise<void> {
    const options = parseCliOptions(args);
    const selected = options.appId
        ? cleaners.filter((cleaner) => cleaner.id === options.appId)
        : cleaners;
    if (selected.length === 0) {
        throw new Error(
            `Unknown application "${options.appId}". Valid IDs: ${cleaners.map((cleaner) => cleaner.id).join(", ")}`,
        );
    }
    p.intro(pc.bgCyan(pc.black(` ${projectName} `)));
    await withRunLock(paths, async () => {
        const audit = await AuditLogger.create(options.logDirectory);
        const summary = newSummary();
        const applications = selected.length === 1 ? "application" : "applications";
        p.log.step(`Scanning ${selected.length} ${applications} for cleanup targets…`);
        const results = await scan(selected, audit, summary, false);
        const choices = options.all || options.appId ? results : await chooseResults(results);
        if (choices === null) {
            await finishAudit(audit, summary, options.dryRun, []);
            p.cancel(`Cleanup cancelled. No files were removed. Audit log at ${audit.path}`);
            return;
        }
        const targets = deduplicate(choices);
        await runCleanup(targets, audit, summary, { dryRun: options.dryRun, signIn: false });
        await finishAudit(
            audit,
            summary,
            options.dryRun,
            choices.map((result) => result.cleaner.id),
        );
        const result = options.dryRun
            ? `${formatBytes(sumKnownBytes(targets.flatMap((item) => item.candidates)))} detected.`
            : `${formatBytes(summary.reclaimedBytes)} reclaimed across ${summary.removedEntries} entries.`;
        const bytesByDrive = options.dryRun ? new Map<string, number>() : summary.bytesByDrive;
        if (options.dryRun) {
            for (const candidate of targets.flatMap((item) => item.candidates)) {
                if (!candidate.canonicalPath || candidate.sizeBytes === null) continue;
                const drive = parse(candidate.canonicalPath).root;
                bytesByDrive.set(drive, (bytesByDrive.get(drive) ?? 0) + candidate.sizeBytes);
            }
        }
        const drives = [...bytesByDrive].map(([drive, size]) => `${drive} ${formatBytes(size)}`);
        p.note(
            [
                result,
                ...drives,
                `${summary.failures} failure(s).`,
                `Detailed log: ${audit.path}`,
            ].join("\n"),
            "Summary",
        );
        p.outro(summary.failures ? pc.yellow("Finished with warnings") : pc.green("Finished"));
    });
}
