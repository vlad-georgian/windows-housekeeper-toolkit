import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, realpath, rename, rmdir, statfs, symlink, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { canonicalPathKey, isPathInside } from '../core/filesystem/index.ts'
import { entryIdentity, hasErrorCode } from '../core/filesystem/paths.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import {
    createDestinationParents,
    type DirectoryIdentity,
    inspectDestinationPath,
    inspectDirectoryPath,
    readDirectoryIdentity,
    requireDirectoryIdentity
} from './directory-path.ts'
import type { RecoveryJournal, RecoveryRecord, TransferPhase } from './journal.ts'
import { nearestExistingPath } from './layout.ts'
import { copyTree, removeTree, removeVerifiedTree, snapshotTree, type TreeManifest, verifyTree, verifyTreeContents } from './tree.ts'

export { UnsupportedTreeError } from './tree.ts'

/** One original directory and its mirrored destination under the relocation base. */
export interface DirectoryTransfer {
    readonly appId: string
    readonly original: string
    readonly destination: string
    /** The relocation base bounds cleanup of newly created folders when a move is undone. */
    readonly base: string
}

export interface TransferOptions {
    readonly journal: RecoveryJournal
    /** Existing destination directories captured before showing the combined plan. */
    readonly destinationDirectories?: readonly DirectoryIdentity[]
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

/** Removes empty destination parents created by the current move, stopping below the base. */
async function pruneEmptyParents(created: readonly DirectoryIdentity[], base: string): Promise<void> {
    for (const { path, identity } of created.toReversed()) {
        if (!isPathInside(path, base)) return
        try {
            await requireDirectoryIdentity(path, identity)
            await rmdir(path)
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

interface MoveProgress {
    readonly createdParents: DirectoryIdentity[]
    destinationParents: readonly DirectoryIdentity[]
    stagingIdentity?: string | null
    placed: boolean
    renamedOriginal: boolean
    junctionIdentity?: string
}

async function undoMove(
    transfer: DirectoryTransfer,
    record: RecoveryRecord,
    progress: MoveProgress,
    manifest: TreeManifest,
    originalDirectories: readonly DirectoryIdentity[]
): Promise<void> {
    const { original, destination, base } = transfer
    const { aside, staging } = record
    if (progress.renamedOriginal && aside !== null) {
        await inspectDirectoryPath(dirname(original), originalDirectories.slice(0, -1))
        const source = originalDirectories.at(-1)
        if (!source) throw new Error(`The identity of ${original} could not be verified.`)
        await requireDirectoryIdentity(aside, source.identity)
        if (progress.junctionIdentity !== undefined) {
            const junction = await lstat(original, { bigint: true })
            if (!junction.isSymbolicLink() || entryIdentity(junction) !== progress.junctionIdentity) throw new Error(`The junction at ${original} changed.`)
            await unlink(original)
        }
        if (await lstatIfPresent(original)) throw new Error(`Both ${original} and ${aside} exist.`)
        await rename(aside, original)
    }
    const identity = progress.stagingIdentity
    if (identity !== undefined) {
        if (identity === null) throw new Error(`The identity of ${staging} could not be verified.`)
        await inspectDestinationPath(base, destination, 'move', progress.destinationParents)
        if (progress.placed) await removeTree(destination, manifest, identity)
        else {
            await requireDirectoryIdentity(staging, identity)
            await removeVerifiedTree(staging)
        }
    }
    await pruneEmptyParents(progress.createdParents, base)
}

/**
 * Moves a plain directory to its mirrored destination and leaves a verified junction at the
 * original path. The copy is verified, including permissions, before source space is reclaimed.
 * An interruption before the junction is verified is undone; afterwards the recovery record is kept.
 */
export async function moveDirectory(transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    const { original, destination, base } = transfer
    const originalDirectories = await inspectDirectoryPath(original)
    const source = originalDirectories.at(-1)
    if (!source || canonicalPathKey(source.path) !== canonicalPathKey(original)) throw new Error(`${original} is not a plain directory.`)
    const destinationParents = await inspectDestinationPath(base, destination, 'move', options.destinationDirectories)
    await requireAbsent(destination)
    const manifest = await snapshotTree(original)
    const tracker = phaseTracker(newRecord('move', transfer), options)
    const { staging, aside, id } = tracker.record()
    if (!aside) throw new Error('A move needs a path for the original directory.')
    await requireAbsent(staging)
    await requireAbsent(aside)
    await requireCapacity(dirname(destination), manifest.bytes)

    const progress: MoveProgress = { createdParents: [], destinationParents, placed: false, renamedOriginal: false }
    try {
        await tracker.enter('copying')
        progress.destinationParents = await createDestinationParents(dirname(destination), destinationParents, progress.createdParents)
        if (progress.createdParents[0]) await tracker.update({ createdParent: progress.createdParents[0].path })
        await inspectDestinationPath(base, destination, 'move', progress.destinationParents)
        await requireAbsent(destination)
        await inspectDirectoryPath(original, originalDirectories)
        await copyTree(original, staging, async () => {
            progress.stagingIdentity = null
            progress.stagingIdentity = (await readDirectoryIdentity(staging)).identity
        })
        await verifyTree(staging, manifest)
        const stagedIdentity = progress.stagingIdentity
        if (!stagedIdentity) throw new Error(`The identity of ${staging} could not be verified.`)

        await tracker.enter('swapping')
        await inspectDestinationPath(base, destination, 'move', progress.destinationParents)
        await requireAbsent(destination)
        await requireDirectoryIdentity(staging, stagedIdentity)
        await rename(staging, destination)
        progress.placed = true
        await requireDirectoryIdentity(destination, stagedIdentity)
        await inspectDirectoryPath(original, originalDirectories)
        await requireAbsent(aside)
        await rename(original, aside)
        progress.renamedOriginal = true
        // Detect writes that happened while copying.
        await verifyTreeContents(aside, manifest)
        await symlink(destination, original, 'junction')
        progress.junctionIdentity = entryIdentity(await lstat(original, { bigint: true }))
        await verifyJunction(original, destination)
    } catch (error) {
        try {
            await undoMove(transfer, tracker.record(), progress, manifest, originalDirectories)
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
        await inspectDestinationPath(base, destination, 'move', progress.destinationParents)
        const stagedIdentity = progress.stagingIdentity
        if (!stagedIdentity) throw new Error(`The identity of ${destination} could not be verified.`)
        await requireDirectoryIdentity(destination, stagedIdentity)
        await verifyJunction(original, destination)
        await inspectDirectoryPath(dirname(original), originalDirectories.slice(0, -1))
        await removeTree(aside, manifest, source.identity)
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

/**
 * Restores the latest contents of a relocated directory to its original path, replacing the
 * junction. The restored copy is verified before destination space is released. Parent
 * directories are kept because their ownership is unknown after a completed move.
 */
export async function restoreDirectory(transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    const { original, destination, base } = transfer
    const originalParents = await inspectDirectoryPath(dirname(original))
    if (!(await linksTo(original, destination))) throw new Error(`${original} does not link to ${destination}.`)
    const originalJunction = entryIdentity(await lstat(original, { bigint: true }))
    const destinationDirectories = await inspectDestinationPath(base, destination, 'restore', options.destinationDirectories)
    const relocated = destinationDirectories.at(-1)
    if (!relocated || canonicalPathKey(relocated.path) !== canonicalPathKey(destination)) throw new Error(`${destination} is not a plain directory.`)
    const manifest = await snapshotTree(destination)
    const tracker = phaseTracker(newRecord('restore', transfer), options)
    const { staging, id } = tracker.record()
    await requireAbsent(staging)
    await requireCapacity(dirname(original), manifest.bytes)

    let stagingIdentity: string | null | undefined
    let removedJunction = false
    try {
        await tracker.enter('copying')
        await inspectDestinationPath(base, destination, 'restore', destinationDirectories)
        await inspectDirectoryPath(dirname(original), originalParents)
        await copyTree(destination, staging, async () => {
            stagingIdentity = null
            stagingIdentity = (await readDirectoryIdentity(staging)).identity
        })
        await verifyTree(staging, manifest)

        await tracker.enter('swapping')
        await inspectDestinationPath(base, destination, 'restore', destinationDirectories)
        await inspectDirectoryPath(dirname(original), originalParents)
        if (!stagingIdentity) throw new Error(`The identity of ${staging} could not be verified.`)
        await requireDirectoryIdentity(staging, stagingIdentity)
        const junction = await lstat(original, { bigint: true })
        if (entryIdentity(junction) !== originalJunction || !(await linksTo(original, destination))) throw new Error(`${original} no longer links to ${destination}.`)
        await unlink(original)
        removedJunction = true
        // Detect writes that happened while copying.
        await verifyTreeContents(destination, manifest)
        await inspectDirectoryPath(dirname(original), originalParents)
        await requireDirectoryIdentity(staging, stagingIdentity)
        await requireAbsent(original)
        await rename(staging, original)
    } catch (error) {
        try {
            if (removedJunction || stagingIdentity !== undefined) await inspectDirectoryPath(dirname(original), originalParents)
            if (removedJunction) {
                await inspectDestinationPath(base, destination, 'restore', destinationDirectories)
                await requireAbsent(original)
                await symlink(destination, original, 'junction')
                await verifyJunction(original, destination)
            }
            if (stagingIdentity !== undefined) {
                if (stagingIdentity === null) throw new Error(`The identity of ${staging} could not be verified.`, { cause: error })
                await requireDirectoryIdentity(staging, stagingIdentity)
                await removeVerifiedTree(staging)
            }
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
        await inspectDestinationPath(base, destination, 'restore', destinationDirectories)
        await inspectDirectoryPath(dirname(original), originalParents)
        if (!stagingIdentity) throw new Error(`The identity of ${original} could not be verified.`)
        await requireDirectoryIdentity(original, stagingIdentity)
        await removeTree(destination, manifest, relocated.identity)
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
