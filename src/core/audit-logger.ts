import { appendFile, mkdir } from 'node:fs/promises'
import { parse, resolve } from 'node:path'

import { projectName } from './state.ts'
import type { CleanupCandidate, RemovedEntry, SkippedEntry } from './types.ts'

type AuditDetails = Record<string, unknown>
type RelocationAuditKind = 'moved' | 'restored' | 'previewed' | 'skipped' | 'failed'

export class AuditLogger {
    private constructor(readonly path: string) {}

    static async create(logDirectory: string): Promise<AuditLogger> {
        const resolvedDirectory = resolve(logDirectory)
        await mkdir(resolvedDirectory, { recursive: true })
        const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-')
        const logger = new AuditLogger(resolve(resolvedDirectory, `${projectName}-${timestamp}-${process.pid}.log`))
        await logger.write('session-start', {
            processId: process.pid,
            workingDirectory: process.cwd(),
            platform: process.platform,
            bunVersion: Bun.version
        })
        return logger
    }

    private async write(event: string, details: AuditDetails): Promise<void> {
        const record = JSON.stringify({
            timestamp: new Date().toISOString(),
            event,
            ...details
        })
        await appendFile(this.path, `${record}\n`, 'utf8')
    }

    async recordDetection(appId: string, appLabel: string, candidate: CleanupCandidate): Promise<void> {
        await this.write('candidate-detected', {
            appId,
            appLabel,
            candidateId: candidate.id,
            candidateKind: candidate.kind,
            displayName: candidate.displayName,
            path: candidate.path ?? candidate.publishedName,
            resolvedPath: candidate.canonicalPath ?? candidate.path,
            aliases: candidate.filesystemAliases,
            drive: candidate.canonicalPath ? parse(candidate.canonicalPath).root : null,
            reason: candidate.reason,
            sizeBytes: candidate.sizeBytes,
            fileCount: candidate.fileCount,
            modifiedAt: candidate.modifiedAt?.toISOString() ?? null,
            driverVersion: candidate.driverVersion ?? null
        })
    }

    async recordRemoved(appId: string, appLabel: string, candidate: CleanupCandidate, entry: RemovedEntry): Promise<void> {
        await this.write('entry-removed', {
            appId,
            appLabel,
            candidateId: candidate.id,
            candidate: candidate.displayName,
            entryKind: entry.kind,
            path: entry.path,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt?.toISOString() ?? null,
            reason: candidate.reason
        })
    }

    async recordDryRun(appId: string, appLabel: string, candidate: CleanupCandidate): Promise<void> {
        await this.write('dry-run-skip', {
            appId,
            appLabel,
            candidateId: candidate.id,
            candidate: candidate.displayName,
            path: candidate.path ?? candidate.publishedName,
            sizeBytes: candidate.sizeBytes,
            fileCount: candidate.fileCount,
            reason: candidate.reason
        })
    }

    async recordError(appId: string, appLabel: string, candidate: CleanupCandidate | null, error: unknown): Promise<void> {
        await this.write('error', {
            appId,
            appLabel,
            candidateId: candidate?.id ?? null,
            candidate: candidate?.displayName ?? null,
            path: candidate?.path ?? candidate?.publishedName ?? null,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : null
        })
    }

    async finish(details: AuditDetails): Promise<void> {
        await this.write('session-finish', details)
    }

    async recordSkip(appId: string, reason: string): Promise<void> {
        await this.write('app-skipped', { appId, reason })
    }

    async recordSkippedEntry(appId: string, appLabel: string, candidate: CleanupCandidate, entry: SkippedEntry): Promise<void> {
        await this.write('entry-skipped', {
            appId,
            appLabel,
            candidateId: candidate.id,
            candidate: candidate.displayName,
            path: entry.path,
            reason: entry.reason
        })
    }

    async recordRelocation(kind: RelocationAuditKind, details: AuditDetails): Promise<void> {
        await this.write(`relocation-${kind}`, details)
    }

    async recordStartupEnforcement(messages: readonly string[], failures: number): Promise<void> {
        await this.write('startup-preference-enforcement', { messages, failures })
    }
}
