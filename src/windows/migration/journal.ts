import { join, parse } from 'node:path'

import { readState, writeState } from '../../core/state.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import { isLocalPath, logNames, samePath, type LogFile } from './files.ts'

const journal = 'migration-codex-logs.json'
const phases = ['copying', 'redirecting', 'reclaiming', 'moved', 'rolling-back', 'restoring-setting', 'rolled-back'] as const
type Phase = (typeof phases)[number]
export interface Migration {
    readonly id: string
    readonly home: string
    readonly homeIdentity: string
    readonly destination: string
    readonly destinationIdentity: string | null
    readonly priorLogDir: null
    readonly phase: Phase
    readonly original: readonly LogFile[]
    readonly latest: readonly LogFile[] | null
    readonly rollbackSource: readonly LogFile[]
}

function validManifest(files: unknown): files is readonly LogFile[] {
    return (
        Array.isArray(files) &&
        files.length > 0 &&
        files.length <= logNames.length &&
        new Set(files.map((file) => file?.name)).size === files.length &&
        files.every(
            (file) =>
                file &&
                logNames.includes(file.name) &&
                Number.isSafeInteger(file.bytes) &&
                file.bytes >= 0 &&
                typeof file.sha256 === 'string' &&
                /^[a-f0-9]{64}$/u.test(file.sha256)
        )
    )
}

export async function migrationRecord(paths: SystemPaths): Promise<Migration | null> {
    const value = await readState<Migration | null>(paths, journal, null)
    if (value === null) return null
    if (
        typeof value !== 'object' ||
        typeof value.home !== 'string' ||
        !samePath(value.home, join(paths.home, '.codex')) ||
        !phases.includes(value.phase) ||
        typeof value.destination !== 'string' ||
        !isLocalPath(value.destination) ||
        samePath(value.destination, parse(value.destination).root) ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9-]{36}$/u.test(value.id) ||
        typeof value.homeIdentity !== 'string' ||
        value.priorLogDir !== null ||
        (value.destinationIdentity !== null && typeof value.destinationIdentity !== 'string') ||
        (value.phase !== 'copying' && value.phase !== 'rolled-back' && !value.destinationIdentity) ||
        !validManifest(value.original) ||
        (value.latest !== null && !validManifest(value.latest)) ||
        !(Array.isArray(value.rollbackSource) && (value.rollbackSource.length === 0 || validManifest(value.rollbackSource))) ||
        (['rolling-back', 'restoring-setting'].includes(value.phase) && value.latest === null)
    ) {
        throw new Error('The Codex migration journal is invalid. Keep the source and destination files for recovery.')
    }
    return value
}

export async function savePhase(paths: SystemPaths, operation: Migration, phase: Phase): Promise<Migration> {
    const next = { ...operation, phase }
    await saveMigration(paths, next)
    return next
}

export async function saveMigration(paths: SystemPaths, operation: Migration): Promise<void> {
    await writeState(paths, journal, operation)
}
