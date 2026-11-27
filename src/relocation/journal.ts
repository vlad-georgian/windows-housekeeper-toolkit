import { join } from 'node:path'

import { canonicalPathKey } from '../core/filesystem/paths.ts'
import { readState, stateDirectory, writeState } from '../core/state.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { OriginalLink } from './inspect.ts'

export const transferPhases = ['copying', 'swapping', 'reclaiming', 'releasing'] as const
/**
 * `copying` writes and verifies a copy in the staging directory; nothing else has changed yet.
 * `swapping` renames the copy into place and replaces the original path with a junction (move)
 * or the junction with the copy (restore). `reclaiming` removes the set-aside original after a
 * move, and `releasing` removes the destination after a restore.
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
    readonly originalLink?: OriginalLink
    /** Original physical mirror set aside while installing its forwarding link. */
    readonly backingAside?: string
    readonly forwardingAside?: string
    /** The highest destination parent a move created, so undoing it removes only its own folders. */
    readonly createdParent?: string | null
    readonly phase: TransferPhase
    readonly startedAt: string
}

/** Recovery records for incomplete relocation transfers. */
export interface RecoveryJournal {
    readAliases?(key: string): Promise<import('./tree.ts').CopiedFiles>
    saveAliases?(key: string, aliases: import('./tree.ts').CopiedFiles): Promise<void>
    /** Where the records are kept, for messages that point the user to them. */
    readonly location: string
    /** Identity of the mirror created for this original by a completed transfer. */
    owner(original: string): Promise<{ path: string; identity: string; forwarding?: true } | undefined>
    setOwner(original: string, owner: { path: string; identity: string; forwarding?: true } | null): Promise<void>
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
        (record.createdParent === undefined || record.createdParent === null || typeof record.createdParent === 'string') &&
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
    const ownersName = 'relocation-destinations.json'
    const readOwners = async () => {
        const value = await readState<unknown>(paths, ownersName, {})
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relocation destination records.')
        const owners = new Map<string, { path: string; identity: string; forwarding?: true }>()
        for (const [key, owner] of Object.entries(value)) {
            if (typeof owner !== 'object' || !owner || !('identity' in owner) || typeof owner.identity !== 'string' || !('path' in owner) || typeof owner.path !== 'string')
                throw new Error('Invalid relocation destination identity.')
            owners.set(key, { path: owner.path, identity: owner.identity, ...('forwarding' in owner && owner.forwarding === true && { forwarding: true }) })
        }
        return owners
    }
    const aliasesName = 'relocation-aliases.json'
    type AliasState = Record<string, Record<string, { path: string; identity: string; forwarding?: true }>>
    return {
        async readAliases(key) {
            const aliases = await readState<AliasState>(paths, aliasesName, {})
            return new Map(Object.entries(aliases[key] ?? {}))
        },
        async saveAliases(key, aliases) {
            const state = await readState<AliasState>(paths, aliasesName, {})
            if (aliases.size) state[key] = Object.fromEntries(aliases)
            else delete state[key]
            await writeState(paths, aliasesName, state)
        },
        owner: async (original) => (await readOwners()).get(canonicalPathKey(original)),
        async setOwner(original, owner) {
            const owners = await readOwners()
            if (owner) owners.set(canonicalPathKey(original), owner)
            else owners.delete(canonicalPathKey(original))
            await writeState(paths, ownersName, Object.fromEntries(owners))
        },
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
