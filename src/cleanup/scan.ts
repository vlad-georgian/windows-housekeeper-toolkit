import * as p from "@clack/prompts";

import type { AuditLogger } from "../core/audit-logger.ts";
import { isPathInside } from "../core/filesystem/index.ts";
import { errorMessage, formatBytes, sumKnownBytes } from "../core/format.ts";
import type { AppCleaner, CleanupCandidate, DetectionResult } from "../core/types.ts";
import { isAppRunning, listWindowsProcesses } from "../windows/processes.ts";
import type { CleanupSummary } from "./summary.ts";

export function optionHint(result: DetectionResult): string {
    if (result.candidates.length === 0) return "nothing removable detected";
    const unknown = result.candidates.some((candidate) => candidate.sizeBytes === null);
    return `${result.candidates.length} target(s), ${formatBytes(result.totalBytes)}${unknown ? " + driver package" : ""}`;
}

export async function scan(
    cleaners: readonly AppCleaner[],
    audit: AuditLogger,
    summary: CleanupSummary,
    signIn: boolean,
): Promise<DetectionResult[]> {
    const processes = signIn ? await listWindowsProcesses() : [];
    const results = await Promise.all(
        cleaners.map(async (cleaner): Promise<DetectionResult | null> => {
            try {
                if (signIn && isAppRunning(cleaner.id, processes)) {
                    summary.skippedApps.add(cleaner.label);
                    await audit.recordSkip(cleaner.id, "Application is running");
                    return null;
                }
                const detected = await cleaner.detect();
                const candidates = signIn
                    ? detected.filter((candidate) => candidate.kind === "filesystem")
                    : detected;
                return { cleaner, candidates, totalBytes: sumKnownBytes(candidates) };
            } catch (error) {
                summary.failures += 1;
                summary.failedApps.add(cleaner.label);
                await audit.recordError(cleaner.id, cleaner.label, null, error);
                if (!signIn) p.log.error(`Could not scan ${cleaner.label}: ${errorMessage(error)}`);
                return null;
            }
        }),
    );
    return results.filter((result) => result !== null);
}

export function deduplicate(selections: readonly DetectionResult[]): DetectionResult[] {
    const selected = selections.flatMap((result) => result.candidates);
    // Process parents first so an overlapping target can only contribute once.
    selected.sort(
        (left, right) => (left.canonicalPath?.length ?? 0) - (right.canonicalPath?.length ?? 0),
    );
    const unique = new Set<CleanupCandidate>();
    const paths = new Set<string>();
    for (const candidate of selected) {
        const path = candidate.canonicalPath?.toLowerCase();
        if (path && [...paths].some((prior) => path === prior || isPathInside(path, prior)))
            continue;
        unique.add(candidate);
        if (path) paths.add(path);
    }
    return selections.map((result) => {
        const candidates = result.candidates.filter((candidate) => unique.has(candidate));
        return { ...result, candidates, totalBytes: sumKnownBytes(candidates) };
    });
}
