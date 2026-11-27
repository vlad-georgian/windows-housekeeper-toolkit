import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { link, lstat, readlink, realpath, rename, rmdir, statfs, symlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { canonicalPathKey, isPathInside } from '../core/filesystem/index.ts'
import { entryIdentity, hasErrorCode } from '../core/filesystem/paths.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import type { ReclamationEntry, ReclamationGuard } from '../windows/reclaim-tree.ts'
import { createDestinationParents, inspectDestinationPath, inspectDirectoryPath, type DirectoryIdentity, requireDirectoryIdentity, storedLinkTarget } from './directory-path.ts'
import type { OriginalLink } from './inspect.ts'
import type { RecoveryJournal, RecoveryRecord, TransferPhase } from './journal.ts'
import { nearestExistingPath } from './layout.ts'
import {
    type CopiedFiles,
    registerCopies,
    remapExternalLinks,
    copyTree,
    reclaimPublishedAlias,
    reclaimRelocationLinks,
    removeTree,
    snapshotRelocationLink,
    snapshotTree,
    type TreeManifest,
    verifyTree,
    verifyTreeContents
} from './tree.ts'

export { UnsupportedTreeError } from './tree.ts'

/** One original directory and its mirrored destination under the relocation base. */
export interface DirectoryTransfer {
    readonly appId: string
    readonly original: string
    readonly originalLink?: OriginalLink
    readonly forwarding?: OriginalLink
    readonly expectedIdentity?: string
    readonly kind?: 'directory' | 'file'
    readonly destination: string
    /** The relocation base bounds cleanup of newly created folders when a move is undone. */
    readonly base: string
}

export interface TransferOptions {
    readonly destinationDirectories?: readonly DirectoryIdentity[]
    readonly copiedFiles?: CopiedFiles
    readonly linkTargets?: ReadonlyMap<string, { from: string; to: string }>
    readonly recordAliases?: (aliases: CopiedFiles) => Promise<void>
    readonly preserveMirror?: boolean
    readonly trackRootAlias?: boolean
    /** Removes the staging alias after an exclusive file publication. */
    readonly removeStagingAlias?: (path: string) => Promise<void>
    readonly journal: RecoveryJournal
    /** Runs after each phase's recovery record is saved. Tests throw here to simulate an interruption. */
    readonly afterVerifyingSurvivor?: (record: RecoveryRecord) => void | Promise<void>
    readonly failReclamationAfter?: number
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
        const expected = canonicalPathKey(target)
        return canonicalPathKey(await storedLinkTarget(path)) === expected && canonicalPathKey(await realpath(path)) === expected
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

async function requirePlainParent(path: string): Promise<void> {
    const parent = await nearestExistingPath(dirname(path))
    if (canonicalPathKey(await realpath(parent)) !== canonicalPathKey(parent)) throw new Error(`${path} has a linked parent.`)
}

async function objectIdentity(path: string): Promise<string> {
    return entryIdentity(await lstat(path, { bigint: true }))
}

async function verifyOriginalLink(path: string, expected: OriginalLink): Promise<void> {
    await requirePlainParent(path)
    if (
        (await objectIdentity(path)) !== expected.identity ||
        (await readlink(path)) !== expected.payload ||
        (expected.indirect ? canonicalPathKey(await realpath(path)) !== canonicalPathKey(expected.target) : !(await linksTo(path, expected.target))) ||
        (await objectIdentity(expected.target)) !== expected.targetIdentity ||
        canonicalPathKey(await realpath(expected.target)) !== canonicalPathKey(expected.target)
    ) {
        throw new Error(`The original link or its target changed at ${path}.`)
    }
}

async function placeCopy(staging: string, destination: string, file: boolean): Promise<void> {
    await requireAbsent(destination)
    if (file) {
        // rename can overwrite a racing file. Creating a hard link is exclusive.
        await link(staging, destination)
    } else await rename(staging, destination)
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
        ...(transfer.originalLink && { originalLink: transfer.originalLink }),
        original: transfer.original,
        destination: transfer.destination,
        staging: action === 'move' ? `${transfer.destination}${tag}.partial` : `${transfer.original}${tag}.restoring`,
        aside: `${transfer.original}${tag}.aside`,
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

/** Move or restore one verified filesystem object. Renaming the live entry aside preserves
 * the exact junction, file symlink or hard-link name for rollback until the swap is verified. */
async function transferPath(action: 'move' | 'restore', transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    const { original, destination } = transfer
    const moving = action === 'move'
    const source = moving ? (transfer.originalLink?.target ?? original) : destination
    const finalRoot = moving ? destination : original
    const originalParents = await inspectDirectoryPath(dirname(original))
    const destinationAction = !moving && transfer.kind !== 'file' ? 'restore' : 'move'
    let directories = await inspectDestinationPath(transfer.base, destination, destinationAction, options.destinationDirectories)
    const sourceParents = await inspectDirectoryPath(dirname(source))
    const created: DirectoryIdentity[] = []
    async function recheckPaths() {
        await inspectDirectoryPath(dirname(original), originalParents)
        await inspectDestinationPath(transfer.base, destination, destinationAction, directories)
        await inspectDirectoryPath(dirname(source), sourceParents)
    }
    if (isPathInside(destination, source) || isPathInside(source, destination) || (moving && canonicalPathKey(source) === canonicalPathKey(destination))) {
        throw new Error(`The source and destination overlap at ${source}.`)
    }
    if (moving && transfer.forwarding) await verifyOriginalLink(destination, transfer.forwarding)
    else if (moving) await requireAbsent(destination)
    else if (!(await linksTo(original, destination))) throw new Error(`${original} does not link to ${destination}.`)

    const manifest = await snapshotTree(source)
    const output = remapExternalLinks(manifest, options.linkTargets)
    const file = manifest.entries[0]?.kind === 'file'
    if (file !== (transfer.kind === 'file')) throw new Error(`${source} is not the expected type.`)
    const originalLink =
        transfer.originalLink ??
        (moving
            ? undefined
            : {
                  target: destination,
                  payload: await readlink(original),
                  identity: await objectIdentity(original),
                  targetIdentity: await objectIdentity(destination)
              })
    if (originalLink) await verifyOriginalLink(original, originalLink)
    const linkKind = file ? 'symlink' : 'junction'
    const originalDescriptor = originalLink && (await snapshotRelocationLink(original, originalLink.identity, { kind: linkKind, payload: originalLink.payload }))
    const forwardingDescriptor =
        transfer.forwarding && (await snapshotRelocationLink(destination, transfer.forwarding.identity, { kind: linkKind, payload: transfer.forwarding.payload }))
    const liveIdentity = await objectIdentity(original)
    if (transfer.expectedIdentity && liveIdentity !== transfer.expectedIdentity) throw new Error(`${original} changed since the plan was confirmed.`)
    const owner = originalLink && (await options.journal.owner(original))
    const ownsBacking =
        owner && originalLink && !originalLink.indirect && canonicalPathKey(owner.path) === canonicalPathKey(originalLink.target) && owner.identity === originalLink.targetIdentity
    const record = newRecord(action, { ...transfer, ...(originalLink && { originalLink }) })
    const backingAside = ownsBacking && (moving || options.preserveMirror) ? `${source}.windows-housekeeper-toolkit-${record.id}.aside` : undefined
    if (backingAside) await requireAbsent(backingAside)
    const forwardingAside = transfer.forwarding ? `${destination}.windows-housekeeper-toolkit-${record.id}.forwarding` : undefined
    if (forwardingAside) await requireAbsent(forwardingAside)
    const tracker = phaseTracker({ ...record, ...(forwardingAside && { forwardingAside }), ...(backingAside && { backingAside }) }, options)
    const { staging, aside, id } = tracker.record()
    if (!aside) throw new Error('A transfer requires a set-aside path.')
    await requireAbsent(staging)
    await requireAbsent(aside)
    await requireCapacity(dirname(finalRoot), manifest.bytes)
    let copy: TreeManifest | undefined
    let published = false
    let forwardingMoved = false
    let setAside = false
    let replacementId: string | undefined
    let replacement: ReclamationEntry | undefined
    function parents(): readonly DirectoryIdentity[] {
        return [...originalParents, ...directories.filter((directory) => canonicalPathKey(directory.path) !== canonicalPathKey(destination)), ...sourceParents]
    }

    async function removeStagingAlias(staged: TreeManifest) {
        if (options.removeStagingAlias) {
            await options.removeStagingAlias(staging)
            return
        }
        await reclaimPublishedAlias(staging, finalRoot, staged, parents())
    }
    await tracker.enter('copying').catch(async (error) => {
        await options.journal.remove(id)
        throw error
    })
    try {
        await recheckPaths()
        if (moving) {
            directories = await createDestinationParents(dirname(destination), directories, created)
            if (created[0]) await tracker.update({ createdParent: created[0].path })
            if (!transfer.forwarding) await requireAbsent(destination)
        }
        await recheckPaths()
        const stagedId = await copyTree(source, staging, output, finalRoot, options.copiedFiles)
        const verified = await verifyTree(staging, output, finalRoot)
        if (verified.entries[0]?.identity !== stagedId) throw new Error(`${staging} changed during the copy.`)
        copy = verified

        await tracker.enter('swapping')
        await recheckPaths()
        if (originalLink) await verifyOriginalLink(original, originalLink)
        if ((await objectIdentity(original)) !== liveIdentity) throw new Error(`${original} changed during relocation.`)
        await verifyTreeContents(source, manifest, source, true)
        await verifyTreeContents(staging, copy, finalRoot, true)
        if (moving) {
            if (forwardingAside && transfer.forwarding) {
                await verifyOriginalLink(destination, transfer.forwarding)
                await requireAbsent(forwardingAside)
                await rename(destination, forwardingAside)
                forwardingMoved = true
            }
            await placeCopy(staging, destination, file)
            published = true
            if (file) await removeStagingAlias(copy)
        }
        await requireAbsent(aside)
        await rename(original, aside)
        setAside = true
        if ((await objectIdentity(aside)) !== liveIdentity) throw new Error(`${aside} changed during the swap.`)
        if (moving) {
            await symlink(destination, original, file ? 'file' : 'junction')
            replacementId = await objectIdentity(original)
            replacement = await snapshotRelocationLink(original, replacementId, { kind: linkKind, payload: destination })
            if (!(await linksTo(original, destination))) throw new Error(`Could not verify the replacement link at ${original}.`)
        } else {
            await placeCopy(staging, original, file)
            published = true
            if (file) await removeStagingAlias(copy)
        }
        await verifyTree(finalRoot, output, finalRoot)
    } catch (error) {
        try {
            await recheckPaths()
            if (moving && replacementId !== undefined) {
                if ((await objectIdentity(original)) !== replacementId || !(await linksTo(original, destination))) throw new Error(`${original} changed.`, { cause: error })
                if (!replacement) throw new Error(`Could not verify the replacement at ${original}.`, { cause: error })
                await reclaimRelocationLinks([replacement], parents())
            }
            if (published && !moving && copy) await removeTree(original, copy, copy.entries[0]?.identity, undefined, undefined, { guards: parents() })
            if (setAside) {
                await requireAbsent(original)
                if ((await objectIdentity(aside)) !== liveIdentity) throw new Error(`${aside} changed.`, { cause: error })
                await rename(aside, original)
            }
            if (published && moving && copy) await removeTree(destination, copy, copy.entries[0]?.identity, undefined, undefined, { guards: parents() })
            if (forwardingMoved && forwardingAside && transfer.forwarding) {
                await requireAbsent(destination)
                if ((await objectIdentity(forwardingAside)) !== transfer.forwarding.identity) throw new Error(`${forwardingAside} changed.`, { cause: error })
                await rename(forwardingAside, destination)
            }
            if (await lstatIfPresent(staging)) {
                if (!copy) throw new Error(`Keep the partial copy at ${staging} for inspection.`, { cause: error })
                await removeTree(staging, copy, copy.entries[0]?.identity, undefined, undefined, { guards: parents() })
            }
            await pruneEmptyParents(created, transfer.base)
        } catch (undoError) {
            throw new IncompleteTransferError(
                `${action} of ${original} failed (${errorMessage(error)}). Recovery details are in ${options.journal.location}: ${errorMessage(undoError)}`,
                tracker.record(),
                { cause: error }
            )
        }
        await options.journal.remove(id)
        throw error
    }

    async function verifySurvivor() {
        if (!copy) throw new Error('Missing verified copy.')
        await inspectDirectoryPath(dirname(original), originalParents)
        if (moving) await inspectDestinationPath(transfer.base, destination, 'move', directories)
        const current = await verifyTree(finalRoot, copy, finalRoot)
        if (current.entries[0]?.identity !== copy.entries[0]?.identity || (await objectIdentity(finalRoot)) !== copy.entries[0]?.identity)
            throw new Error(`${finalRoot} changed during reclamation.`)
        if (moving && ((await objectIdentity(original)) !== replacementId || !(await linksTo(original, destination)))) throw new Error(`${original} changed before reclamation.`)
        await options.afterVerifyingSurvivor?.(tracker.record())
    }
    let result: TransferResult = { files: manifest.files, bytes: manifest.bytes }
    try {
        await tracker.enter(moving ? 'reclaiming' : 'releasing')
        await recheckPaths()
        await verifyTreeContents(finalRoot, copy, finalRoot, true)
        if (moving && ((await objectIdentity(original)) !== replacementId || !(await linksTo(original, destination)))) throw new Error(`${original} changed before reclamation.`)
        if ((await objectIdentity(aside)) !== liveIdentity) throw new Error(`${aside} changed before reclamation.`)
        let forwardingIdentity: string | undefined
        const guards: ReclamationGuard[] = [...parents()]
        if (moving && replacementId) guards.push({ path: original, identity: replacementId, link: { kind: linkKind, payload: destination } })
        const retiringLinks: ReclamationEntry[] = []
        if (forwardingMoved && forwardingAside && forwardingDescriptor) retiringLinks.push({ ...forwardingDescriptor, path: forwardingAside })
        let retiringTree: string | undefined = aside
        if (originalLink && originalDescriptor) {
            await verifyOriginalLink(aside, originalLink)
            await verifyTreeContents(source, manifest, source, true)
            retiringLinks.push({ ...originalDescriptor, path: aside })
            retiringTree = undefined
            if (backingAside) {
                // Preserve the previous mirror name for consumers after its backing copy is released.
                await requireAbsent(backingAside)
                await rename(source, backingAside)
                await symlink(original, source, file ? 'file' : 'junction')
                forwardingIdentity = await objectIdentity(source)
                if (canonicalPathKey(await storedLinkTarget(source)) !== canonicalPathKey(original) || canonicalPathKey(await realpath(source)) !== canonicalPathKey(finalRoot))
                    throw new Error(`Could not verify the forwarding link at ${source}.`)
                guards.push({ path: source, identity: forwardingIdentity, link: { kind: linkKind, payload: original } })
                retiringTree = backingAside
            } else if (!moving && ownsBacking) retiringTree = destination
        }
        const finalIdentity = copy.entries[0]?.identity
        if (!finalIdentity) throw new Error(`Missing verified identity at ${finalRoot}.`)
        if (retiringTree) {
            await removeTree(
                retiringTree,
                manifest,
                manifest.entries[0]?.identity,
                verifySurvivor,
                { path: finalRoot, identity: finalIdentity },
                { guards, links: retiringLinks, failAfter: options.failReclamationAfter, survivorManifest: copy }
            )
        } else {
            await reclaimRelocationLinks(retiringLinks, guards, { path: finalRoot, manifest: copy }, verifySurvivor)
        }
        const verifiedIdentity = copy.entries[0]?.identity
        if (!verifiedIdentity || (await objectIdentity(finalRoot)) !== verifiedIdentity) throw new Error(`${finalRoot} changed during reclamation.`)
        await options.journal.setOwner(
            original,
            moving ? { path: destination, identity: verifiedIdentity } : forwardingIdentity ? { path: destination, identity: forwardingIdentity, forwarding: true } : null
        )
        if ((await objectIdentity(finalRoot)) !== verifiedIdentity) throw new Error(`${finalRoot} changed while recording ownership.`)
        if (options.copiedFiles) {
            result = registerCopies(manifest, copy, finalRoot, options.copiedFiles, options.trackRootAlias)
            await options.recordAliases?.(options.copiedFiles)
        }
    } catch (error) {
        throw new IncompleteTransferError(
            `${original} was swapped, but reclamation failed (${errorMessage(error)}). Recovery details are in ${options.journal.location}.`,
            tracker.record(),
            { cause: error }
        )
    }
    await options.journal.remove(id)
    return result
}

export function moveDirectory(transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    return transferPath('move', transfer, options)
}

export function restoreDirectory(transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    return transferPath('restore', transfer, options)
}
