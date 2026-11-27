import { parse } from 'node:path'

import * as p from '@clack/prompts'
import pc from 'picocolors'

import type { AuditLogger } from '../core/audit-logger.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import type { CleanupCandidate, DetectionResult } from '../core/types.ts'
import { hasProcessGuard, isAppRunning, listWindowsProcesses } from '../windows/processes.ts'
import { optionHint } from './scan.ts'
import type { CleanupSummary } from './summary.ts'

function needsProcessCheck(appId: string, candidate: CleanupCandidate, signIn: boolean): boolean {
    return hasProcessGuard(appId) && (signIn || (appId !== 'npm-cache' && appId !== 'nuget-cache' && !candidate.id.startsWith('codex:release:')))
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
                continue
            }

            try {
                if (needsProcessCheck(cleaner.id, candidate, signIn) && isAppRunning(cleaner.id, await listWindowsProcesses())) {
                    summary.skippedApps.add(cleaner.label)
                    await audit.recordSkip(cleaner.id, 'Application is running')
                    if (!signIn) p.log.warn(`Skipped ${cleaner.label} because it is running.`)
                    continue
                }
                const removal = await cleaner.remove(candidate, {
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
            } catch (error) {
                summary.failures += 1
                summary.failedApps.add(cleaner.label)
                if (!signIn) p.log.error(`Could not remove ${candidate.displayName}: ${errorMessage(error)}`)
                await audit.recordError(cleaner.id, cleaner.label, candidate, error)
            }
        }
    }
}
