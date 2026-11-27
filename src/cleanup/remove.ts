import { parse } from 'node:path'

import * as p from '@clack/prompts'
import pc from 'picocolors'

import type { AuditLogger } from '../core/audit-logger.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import type { AppCleaner, DetectionResult } from '../core/types.ts'
import { hasProcessGuard, isAppRunning, listWindowsProcesses } from '../windows/processes.ts'
import { optionHint } from './scan.ts'
import type { CleanupSummary } from './summary.ts'

function needsProcessCheck(cleaner: AppCleaner, signIn: boolean): boolean {
    return hasProcessGuard(cleaner.appId) && (signIn || cleaner.manualRunningAppCheck !== false)
}

export async function runCleanup(
    selections: readonly DetectionResult[],
    audit: AuditLogger,
    summary: CleanupSummary,
    { dryRun, signIn }: { dryRun: boolean; signIn: boolean }
): Promise<void> {
    for (const result of selections) {
        const { cleaner } = result
        if (!signIn) p.log.step(pc.bold(`${cleaner.label} — ${optionHint(result)}`))
        for (const candidate of result.candidates) {
            await audit.recordDetection(cleaner.id, cleaner.label, candidate)
            const location = candidate.canonicalPath ?? candidate.path ?? candidate.publishedName ?? candidate.displayName
            if (dryRun) {
                const original = candidate.path && candidate.path.toLowerCase() !== location.toLowerCase() ? `\n  Resolves from ${candidate.path}` : ''
                const aliases = (candidate.filesystemAliases ?? []).map((path) => `\n  Linked name ${path}`).join('')
                p.log.message(`${pc.yellow('Would remove')} ${candidate.displayName}\n  ${location}${original}${aliases}\n  ${candidate.reason}`)
                await audit.recordDryRun(cleaner.id, cleaner.label, candidate)
                summary.detectedBytes += candidate.sizeBytes ?? 0
                if (candidate.canonicalPath && candidate.sizeBytes) {
                    const drive = parse(candidate.canonicalPath).root
                    summary.bytesByDrive.set(drive, (summary.bytesByDrive.get(drive) ?? 0) + candidate.sizeBytes)
                }
                continue
            }

            try {
                if (needsProcessCheck(cleaner, signIn) && isAppRunning(cleaner.appId, await listWindowsProcesses())) {
                    summary.skippedApps.add(cleaner.label)
                    await audit.recordSkip(cleaner.id, 'Application is running')
                    if (!signIn) p.log.warn(`Skipped ${cleaner.label} because it is running.`)
                    continue
                }
                let skippedHere = 0
                const removal = await cleaner.remove(candidate, {
                    onSkipped: async (entry) => {
                        skippedHere += 1
                        summary.skippedEntries += 1
                        await audit.recordSkippedEntry(cleaner.id, cleaner.label, candidate, entry)
                    },
                    onRemoved: async (entry) => {
                        summary.removedEntries += 1
                        summary.cleanedApps.add(cleaner.label)
                        const bytes = entry.sizeBytes ?? 0
                        summary.reclaimedBytes += bytes
                        if (bytes > 0) {
                            const drive = parse(candidate.canonicalPath ?? entry.path).root
                            summary.bytesByDrive.set(drive, (summary.bytesByDrive.get(drive) ?? 0) + bytes)
                        }
                        await audit.recordRemoved(cleaner.id, cleaner.label, candidate, entry)
                    }
                })
                if (!signIn && removal.removedEntries > 0) {
                    const size = candidate.sizeBytes === null ? 'size reported by Windows' : formatBytes(removal.reclaimedBytes)
                    p.log.success(`Removed ${candidate.displayName} (${size})\n  ${location}`)
                }
                if (!signIn && skippedHere > 0) {
                    p.log.warn(`Skipped ${skippedHere} locked or inaccessible entries in ${candidate.displayName}. The audit log lists each one.`)
                }
            } catch (error) {
                summary.failures += 1
                summary.failedApps.add(cleaner.label)
                if (!signIn) p.log.error(`Could not remove ${candidate.displayName}: ${errorMessage(error)}`)
                await audit.recordError(cleaner.id, cleaner.label, candidate, error)
            }
        }
    }
}
