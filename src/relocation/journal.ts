import { join } from 'node:path'

import { readState, stateDirectory, writeState } from '../core/state.ts'
import type { SystemPaths } from '../core/system-paths.ts'

export const transferPhases = ['copying', 'swapping', 'reclaiming', 'releasing'] as const
/**
 * `copying` writes a verified copy beside its final location. `swapping` replaces the original
 * path (move) or the junction (restore). `reclaiming` removes the old source after a move, and
 * `releasing` removes the destination after a restore.
 */
export type TransferPhase = (typeof transferPhases)[number]

/** What a relocation transfer owns, saved before each phase so an interrupted run can be recovered. */
export interface RecoveryRecord {
    readonly id: string
    readonly appId: string
    readonly action: 'move' | 'restore'
    /** The original per-user path. */
    readonly original: string
    /** The mirrored path under the relocation base. */
    readonly destination: string
    /** The temporary copy this transfer writes before swapping it into place. */
    readonly staging: string
    /** Where a move sets the original directory aside before linking. */
    readonly aside: string | null
    readonly phase: TransferPhase
    readonly startedAt: string
}

/** Recovery records for incomplete relocation transfers. */
export interface RecoveryJournal {
    /** Where the records are kept, for messages that point the user to them. */
    readonly location: string
    list(): Promise<RecoveryRecord[]>
    save(record: RecoveryRecord): Promise<void>
    remove(id: string): Promise<void>
}

const journalName = 'relocation-recovery.json'

function isRecord(value: unknown): value is RecoveryRecord {
    if (typeof value !== 'object' || value === null) return false
    const record: Partial<Record<keyof RecoveryRecord, unknown>> = value
    return (
        typeof record.id === 'string' &&
        typeof record.appId === 'string' &&
        (record.action === 'move' || record.action === 'restore') &&
        typeof record.original === 'string' &&
        typeof record.destination === 'string' &&
        typeof record.staging === 'string' &&
        (record.aside === null || typeof record.aside === 'string') &&
        transferPhases.some((phase) => phase === record.phase) &&
        typeof record.startedAt === 'string'
    )
}

/** Keeps recovery records in the toolkit's per-user state directory. */
export function createRecoveryJournal(paths: SystemPaths): RecoveryJournal {
    const read = async (): Promise<RecoveryRecord[]> => {
        const value = await readState<unknown>(paths, journalName, [])
        if (!Array.isArray(value) || !value.every(isRecord)) {
            throw new Error(`The relocation recovery journal at ${stateDirectory(paths)} is invalid. Keep the listed files and directories for manual recovery.`)
        }
        return value
    }
    return {
        location: join(stateDirectory(paths), journalName),
        list: read,
        async save(record) {
            const records = await read()
            await writeState(paths, journalName, [...records.filter((entry) => entry.id !== record.id), record])
        },
        async remove(id) {
            const records = await read()
            await writeState(
                paths,
                journalName,
                records.filter((entry) => entry.id !== id)
            )
        }
    }
}
