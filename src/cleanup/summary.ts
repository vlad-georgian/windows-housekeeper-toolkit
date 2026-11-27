import type { AuditLogger } from "../core/audit-logger.ts";

export interface CleanupSummary {
    failures: number;
    reclaimedBytes: number;
    removedEntries: number;
    cleanedApps: Set<string>;
    skippedApps: Set<string>;
    failedApps: Set<string>;
    bytesByDrive: Map<string, number>;
}

export function newSummary(): CleanupSummary {
    return {
        failures: 0,
        reclaimedBytes: 0,
        removedEntries: 0,
        cleanedApps: new Set(),
        skippedApps: new Set(),
        failedApps: new Set(),
        bytesByDrive: new Map(),
    };
}

export async function finishAudit(
    audit: AuditLogger,
    summary: CleanupSummary,
    dryRun: boolean,
    selectedApplications: readonly string[],
): Promise<void> {
    await audit.finish({
        ...summary,
        dryRun,
        selectedApplications,
        cleanedApps: [...summary.cleanedApps],
        skippedApps: [...summary.skippedApps],
        failedApps: [...summary.failedApps],
        bytesByDrive: Object.fromEntries(summary.bytesByDrive),
    });
    if (summary.failures) process.exitCode = 1;
}
