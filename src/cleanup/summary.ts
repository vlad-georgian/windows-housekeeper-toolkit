import type { AuditLogger } from '../core/audit-logger.ts'
import { formatBytes } from '../core/format.ts'

export interface CleanupSummary {
    failures: number
    reclaimedBytes: number
    /** Known bytes of the targets a dry run would remove. */
    detectedBytes: number
    removedEntries: number
    cleanedApps: Set<string>
    skippedApps: Set<string>
    failedApps: Set<string>
    /** Reclaimed bytes, or detected bytes in a dry run, by storage drive. */
    bytesByDrive: Map<string, number>
}

export function newSummary(): CleanupSummary {
    return {
        failures: 0,
        reclaimedBytes: 0,
        detectedBytes: 0,
        removedEntries: 0,
        cleanedApps: new Set(),
        skippedApps: new Set(),
        failedApps: new Set(),
        bytesByDrive: new Map()
    }
}

export async function finishAudit(audit: AuditLogger, summary: CleanupSummary, dryRun: boolean, selectedApplications: readonly string[]): Promise<void> {
    await audit.finish({
        ...summary,
        dryRun,
        selectedApplications,
        cleanedApps: [...summary.cleanedApps],
        skippedApps: [...summary.skippedApps],
        failedApps: [...summary.failedApps],
        bytesByDrive: Object.fromEntries(summary.bytesByDrive)
    })
    if (summary.failures) process.exitCode = 1
}

/** Lines for the end-of-run cleanup summary note. */
export function describeSummary(summary: CleanupSummary, dryRun: boolean, auditPath: string): string[] {
    const result = dryRun
        ? `${formatBytes(summary.detectedBytes)} detected. Nothing was removed.`
        : `${formatBytes(summary.reclaimedBytes)} reclaimed across ${summary.removedEntries} entries.`
    const drives = [...summary.bytesByDrive].map(([drive, size]) => `${drive} ${formatBytes(size)}`)
    const skipped = summary.skippedApps.size ? [`Skipped running apps: ${[...summary.skippedApps].join(', ')}.`] : []
    return [result, ...drives, ...skipped, `${summary.failures} failure(s).`, `Detailed log: ${auditPath}`]
}
