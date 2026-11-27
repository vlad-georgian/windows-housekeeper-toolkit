import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rename, rmdir, statfs, symlink, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { canonicalPathKey, isPathInside } from '../core/filesystem/index.ts'
import { hasErrorCode } from '../core/filesystem/paths.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import type { RecoveryJournal, RecoveryRecord, TransferPhase } from './journal.ts'
import { nearestExistingPath } from './layout.ts'
import { copyTree, removeTree, removeVerifiedTree, snapshotTree, type TreeManifest, verifyTree, verifyTreeContents } from './tree.ts'

export { UnsupportedTreeError } from './tree.ts'

/** One original directory and its mirrored destination under the relocation base. */
export interface DirectoryTransfer {
    readonly appId: string
    readonly original: string
    readonly destination: string
    /** The relocation base. Emptied mirrored parents below it are removed. */
    readonly base: string
}

export interface TransferOptions {
    readonly journal: RecoveryJournal
    /** Runs after each phase's recovery record is saved. Tests throw here to simulate an interruption. */
    readonly beforePhase?: (phase: TransferPhase) => void | Promise<void>
}

export interface TransferResult {
    readonly bytes: number
    readonly files: number
}

/** The destination already holds data. Nothing was changed. */
export class DestinationConflictError extends Error {}

/** A transfer stopped partway and its recovery record was kept in the journal. */
export class IncompleteTransferError extends Error {
    constructor(
        message: string,
        readonly record: RecoveryRecord,
        options?: ErrorOptions
    ) {
        super(message, options)
    }
}

async function lstatIfPresent(path: string): Promise<Stats | null> {
    try {
        return await lstat(path)
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return null
        throw error
    }
}

/** Whether `path` is a link that resolves to the directory at `target`. */
export async function linksTo(path: string, target: string): Promise<boolean> {
    const stats = await lstatIfPresent(path)
    if (!stats?.isSymbolicLink()) return false
    try {
        return canonicalPathKey(await realpath(path)) === canonicalPathKey(await realpath(target))
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return false
        throw error
    }
}

async function requireAbsent(path: string): Promise<void> {
    if (await lstatIfPresent(path)) throw new DestinationConflictError(`${path} already exists. Move or remove it, then try again.`)
}

async function requireCapacity(path: string, bytes: number): Promise<void> {
    const volume = await statfs(await nearestExistingPath(path), { bigint: true })
    const available = volume.bavail * volume.bsize
    if (BigInt(bytes) > available) {
        throw new Error(`Not enough free space for ${path}: ${formatBytes(bytes)} is required and ${formatBytes(Number(available))} is available.`)
    }
}

async function verifyJunction(original: string, destination: string): Promise<void> {
    const [linked, real] = await Promise.all([readdir(original), readdir(destination)])
    if (!(await linksTo(original, destination)) || linked.toSorted().join('\n') !== real.toSorted().join('\n')) {
        throw new Error(`The junction at ${original} does not resolve to ${destination}.`)
    }
}

/**
 * Removes empty directories from `start` upwards, below `base`. With `createdTop`, stops after
 * that directory so folders that existed before the transfer are kept.
 */
async function pruneEmptyParents(start: string, base: string, createdTop?: string | null): Promise<void> {
    if (createdTop === null) return
    const withinCreated = (path: string): boolean => createdTop === undefined || canonicalPathKey(path) === canonicalPathKey(createdTop) || isPathInside(path, createdTop)
    for (let current = start; isPathInside(current, base) && withinCreated(current); current = dirname(current)) {
        try {
            await rmdir(current)
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) continue
            if (hasErrorCode(error, 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EBUSY')) return
            throw error
        }
    }
}

function newRecord(action: RecoveryRecord['action'], transfer: DirectoryTransfer): RecoveryRecord {
    const id = randomUUID()
    const tag = `.windows-housekeeper-toolkit-${id.slice(0, 8)}`
    return {
        id,
        appId: transfer.appId,
        action,
        original: transfer.original,
        destination: transfer.destination,
        staging: action === 'move' ? `${transfer.destination}${tag}.partial` : `${transfer.original}${tag}.restoring`,
        aside: action === 'move' ? `${transfer.original}${tag}.moved` : null,
        createdParent: null,
        phase: 'copying',
        startedAt: new Date().toISOString()
    }
}

/** Saves each phase before running it, so an interrupted transfer leaves recovery information. */
function phaseTracker(
    record: RecoveryRecord,
    { journal, beforePhase }: TransferOptions
): { record(): RecoveryRecord; enter(phase: TransferPhase): Promise<void>; update(changes: Partial<RecoveryRecord>): Promise<void> } {
    let current = record
    return {
        record: () => current,
        async enter(phase) {
            current = { ...current, phase }
            await journal.save(current)
            await beforePhase?.(phase)
        },
        async update(changes) {
            current = { ...current, ...changes }
            await journal.save(current)
        }
    }
}

async function undoMove(record: RecoveryRecord, transfer: DirectoryTransfer, manifest: TreeManifest): Promise<void> {
    const { original, destination, staging } = record
    const aside = record.aside ?? ''
    const current = await lstatIfPresent(original)
    if (current?.isSymbolicLink()) {
        if (!(await linksTo(original, destination))) throw new Error(`${original} links somewhere unexpected.`)
        await unlink(original)
    }
    if (await lstatIfPresent(aside)) {
        if (await lstatIfPresent(original)) throw new Error(`Both ${original} and ${aside} exist.`)
        await rename(aside, original)
    }
    const restored = await lstatIfPresent(original)
    if (!restored?.isDirectory() || restored.isSymbolicLink()) throw new Error(`${original} could not be put back.`)
    if (await lstatIfPresent(staging)) await removeVerifiedTree(staging)
    if (await lstatIfPresent(destination)) await removeTree(destination, manifest)
    await pruneEmptyParents(dirname(destination), transfer.base, record.createdParent)
}

/**
 * Moves a plain directory to its mirrored destination and leaves a verified junction at the
 * original path. The copy is verified, including permissions, before source space is reclaimed.
 * An interruption before the junction is verified is undone; afterwards the recovery record is kept.
 */
export async function moveDirectory(transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    const { original, destination } = transfer
    const stats = await lstatIfPresent(original)
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${original} is not a plain directory.`)
    await requireAbsent(destination)
    const manifest = await snapshotTree(original)
    const tracker = phaseTracker(newRecord('move', transfer), options)
    const { staging, aside, id } = tracker.record()
    if (!aside) throw new Error('A move needs a path for the original directory.')
    await requireAbsent(staging)
    await requireAbsent(aside)
    await requireCapacity(dirname(destination), manifest.bytes)

    try {
        await tracker.enter('copying')
        const createdParent = await mkdir(dirname(destination), { recursive: true })
        // Bun reports the created directory with a `\\?\` long-path prefix.
        if (createdParent !== undefined) await tracker.update({ createdParent: resolve(createdParent.replace(/^\\\\\?\\/u, '')) })
        await copyTree(original, staging)
        await verifyTree(staging, manifest)

        await tracker.enter('swapping')
        await rename(staging, destination)
        await rename(original, aside)
        // Detect writes that happened while copying.
        await verifyTreeContents(aside, manifest)
        await symlink(destination, original, 'junction')
        await verifyJunction(original, destination)
    } catch (error) {
        try {
            await undoMove(tracker.record(), transfer, manifest)
        } catch (undoError) {
            throw new IncompleteTransferError(
                `Moving ${original} failed (${errorMessage(error)}) and could not be undone (${errorMessage(undoError)}). Recovery details are in ${options.journal.location}.`,
                tracker.record(),
                { cause: error }
            )
        }
        await options.journal.remove(id)
        throw error
    }

    try {
        await tracker.enter('reclaiming')
        await removeTree(aside, manifest)
    } catch (error) {
        throw new IncompleteTransferError(
            `${original} now links to ${destination}, but its old copy at ${aside} was not removed (${errorMessage(error)}). Recovery details are in ${options.journal.location}.`,
            tracker.record(),
            { cause: error }
        )
    }
    await options.journal.remove(id)
    return { bytes: manifest.bytes, files: manifest.files }
}

async function undoRestore(record: RecoveryRecord): Promise<void> {
    const { original, destination, staging } = record
    if (!(await lstatIfPresent(original))) await symlink(destination, original, 'junction')
    await verifyJunction(original, destination)
    if (await lstatIfPresent(staging)) await removeVerifiedTree(staging)
}

/**
 * Restores the latest contents of a relocated directory to its original path, replacing the
 * junction. The restored copy is verified before destination space is released. Which mirrored
 * parents the original move created is not recorded, so every emptied folder below the base goes.
 */
export async function restoreDirectory(transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    const { original, destination } = transfer
    if (!(await linksTo(original, destination))) throw new Error(`${original} does not link to ${destination}.`)
    const manifest = await snapshotTree(destination)
    const tracker = phaseTracker(newRecord('restore', transfer), options)
    const { staging, id } = tracker.record()
    await requireAbsent(staging)
    await requireCapacity(dirname(original), manifest.bytes)

    try {
        await tracker.enter('copying')
        await copyTree(destination, staging)
        await verifyTree(staging, manifest)

        await tracker.enter('swapping')
        if (!(await linksTo(original, destination))) throw new Error(`${original} no longer links to ${destination}.`)
        await unlink(original)
        // Detect writes that happened while copying.
        await verifyTreeContents(destination, manifest)
        await rename(staging, original)
    } catch (error) {
        try {
            await undoRestore(tracker.record())
        } catch (undoError) {
            throw new IncompleteTransferError(
                `Restoring ${original} failed (${errorMessage(error)}) and could not be undone (${errorMessage(undoError)}). Recovery details are in ${options.journal.location}.`,
                tracker.record(),
                { cause: error }
            )
        }
        await options.journal.remove(id)
        throw error
    }

    try {
        await tracker.enter('releasing')
        await removeTree(destination, manifest)
        await pruneEmptyParents(dirname(destination), transfer.base)
    } catch (error) {
        throw new IncompleteTransferError(
            `${original} was restored, but the relocated copy at ${destination} was not removed (${errorMessage(error)}). Recovery details are in ${options.journal.location}.`,
            tracker.record(),
            { cause: error }
        )
    }
    await options.journal.remove(id)
    return { bytes: manifest.bytes, files: manifest.files }
}
