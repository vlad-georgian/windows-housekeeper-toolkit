import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { link, lstat, readlink, realpath, rmdir, statfs, symlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { canonicalPathKey, isPathInside } from '../core/filesystem/index.ts'
import { entryIdentity, hasErrorCode } from '../core/filesystem/paths.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import { moveExclusive } from '../windows/kernel32.ts'
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
    /** Runs just before each set-aside or rollback move. Tests occupy the target here to simulate a racing writer. */
    readonly beforeMove?: (from: string, to: string) => void | Promise<void>
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

async function placeCopy(options: TransferOptions, staging: string, destination: string, file: boolean): Promise<void> {
    // rename can replace a racing file even when the source is a folder. Both publications are exclusive.
    if (file) {
        await requireAbsent(destination)
        await link(staging, destination)
    } else await moveEntry(options, staging, destination)
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

/** The captured ancestry of the original, source and destination, rechecked before each step. */
interface TransferPaths {
    /** Destination parents created by this move, for rollback. */
    readonly created: DirectoryIdentity[]
    recheck(): Promise<void>
    recheckForSurvivor(): Promise<void>
    createDestinationParents(onCreated: (path: string) => Promise<void>): Promise<void>
    parents(): readonly DirectoryIdentity[]
}

async function captureTransferPaths(transfer: DirectoryTransfer, moving: boolean, source: string, known: TransferOptions['destinationDirectories']): Promise<TransferPaths> {
    const { original, destination, base } = transfer
    const destinationAction = !moving && transfer.kind !== 'file' ? 'restore' : 'move'
    const originalParents = await inspectDirectoryPath(dirname(original))
    let directories = await inspectDestinationPath(base, destination, destinationAction, known)
    const sourceParents = await inspectDirectoryPath(dirname(source))
    const created: DirectoryIdentity[] = []
    return {
        created,
        async recheck() {
            await inspectDirectoryPath(dirname(original), originalParents)
            await inspectDestinationPath(base, destination, destinationAction, directories)
            await inspectDirectoryPath(dirname(source), sourceParents)
        },
        async recheckForSurvivor() {
            await inspectDirectoryPath(dirname(original), originalParents)
            if (moving) await inspectDestinationPath(base, destination, 'move', directories)
        },
        async createDestinationParents(onCreated) {
            directories = await createDestinationParents(dirname(destination), directories, created)
            if (created[0]) await onCreated(created[0].path)
        },
        parents: () => [...originalParents, ...directories.filter((directory) => canonicalPathKey(directory.path) !== canonicalPathKey(destination)), ...sourceParents]
    }
}

/** Paths, snapshots and recovery names a transfer works from, all checked before anything changes. */
interface TransferPlan {
    readonly transfer: DirectoryTransfer
    readonly options: TransferOptions
    readonly moving: boolean
    readonly source: string
    readonly finalRoot: string
    readonly file: boolean
    readonly linkKind: 'junction' | 'symlink'
    readonly manifest: TreeManifest
    readonly output: TreeManifest
    readonly originalLink: OriginalLink | undefined
    readonly originalDescriptor: ReclamationEntry | undefined
    readonly forwardingDescriptor: ReclamationEntry | undefined
    readonly liveIdentity: string
    readonly ownsBacking: boolean
    readonly tracker: ReturnType<typeof phaseTracker>
    readonly staging: string
    readonly aside: string
    readonly paths: TransferPaths
}

/** What the swap has changed so far. Undo reverses exactly these steps. */
interface SwapProgress {
    copy?: TreeManifest
    published: boolean
    forwardingMoved: boolean
    setAside: boolean
    replacementId?: string
    replacement?: ReclamationEntry
}

async function prepareTransfer(action: 'move' | 'restore', transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferPlan> {
    const { original, destination } = transfer
    const moving = action === 'move'
    const source = moving ? (transfer.originalLink?.target ?? original) : destination
    const finalRoot = moving ? destination : original
    const paths = await captureTransferPaths(transfer, moving, source, options.destinationDirectories)
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
        !!owner &&
        !!originalLink &&
        !originalLink.indirect &&
        canonicalPathKey(owner.path) === canonicalPathKey(originalLink.target) &&
        owner.identity === originalLink.targetIdentity
    const record = newRecord(action, { ...transfer, ...(originalLink && { originalLink }) })
    const backingAside = ownsBacking && (moving || options.preserveMirror) ? `${source}.windows-housekeeper-toolkit-${record.id}.aside` : undefined
    if (backingAside) await requireAbsent(backingAside)
    const forwardingAside = transfer.forwarding ? `${destination}.windows-housekeeper-toolkit-${record.id}.forwarding` : undefined
    if (forwardingAside) await requireAbsent(forwardingAside)
    const tracker = phaseTracker({ ...record, ...(forwardingAside && { forwardingAside }), ...(backingAside && { backingAside }) }, options)
    const { staging, aside } = tracker.record()
    if (!aside) throw new Error('A transfer requires a set-aside path.')
    await requireAbsent(staging)
    await requireAbsent(aside)
    await requireCapacity(dirname(finalRoot), manifest.bytes)
    return {
        transfer,
        options,
        moving,
        source,
        finalRoot,
        file,
        linkKind,
        manifest,
        output,
        originalLink,
        originalDescriptor,
        forwardingDescriptor,
        liveIdentity,
        ownsBacking,
        tracker,
        staging,
        aside,
        paths
    }
}

/** `rename` would replace a file that appeared at `to`; this fails closed instead. */
async function moveEntry(options: TransferOptions, from: string, to: string): Promise<void> {
    await options.beforeMove?.(from, to)
    try {
        await moveExclusive(from, to)
    } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) throw new DestinationConflictError(`${to} already exists. Move or remove it, then try again.`, { cause: error })
        throw error
    }
}

async function removeStagingAlias(plan: TransferPlan, staged: TreeManifest): Promise<void> {
    if (plan.options.removeStagingAlias) await plan.options.removeStagingAlias(plan.staging)
    else await reclaimPublishedAlias(plan.staging, plan.finalRoot, staged, plan.paths.parents())
}

/** Copy and verify in staging, then swap the copy into place, recording each step in `progress`. */
async function swapIntoPlace(plan: TransferPlan, progress: SwapProgress): Promise<void> {
    const { transfer, options, moving, source, finalRoot, file, linkKind, manifest, output, originalLink, liveIdentity, tracker, staging, aside, paths } = plan
    const { original, destination } = transfer
    const { forwardingAside } = tracker.record()
    await paths.recheck()
    if (moving) {
        await paths.createDestinationParents((createdParent) => tracker.update({ createdParent }))
        if (!transfer.forwarding) await requireAbsent(destination)
    }
    await paths.recheck()
    const stagedId = await copyTree(source, staging, output, finalRoot, options.copiedFiles)
    const copy = await verifyTree(staging, output, finalRoot)
    if (copy.entries[0]?.identity !== stagedId) throw new Error(`${staging} changed during the copy.`)
    progress.copy = copy

    await tracker.enter('swapping')
    await paths.recheck()
    if (originalLink) await verifyOriginalLink(original, originalLink)
    if ((await objectIdentity(original)) !== liveIdentity) throw new Error(`${original} changed during relocation.`)
    await verifyTreeContents(source, manifest, source, true)
    await verifyTreeContents(staging, copy, finalRoot, true)
    if (moving) {
        if (forwardingAside && transfer.forwarding) {
            await verifyOriginalLink(destination, transfer.forwarding)
            await moveEntry(options, destination, forwardingAside)
            progress.forwardingMoved = true
        }
        await placeCopy(options, staging, destination, file)
        progress.published = true
        if (file) await removeStagingAlias(plan, copy)
    }
    await moveEntry(options, original, aside)
    progress.setAside = true
    if ((await objectIdentity(aside)) !== liveIdentity) throw new Error(`${aside} changed during the swap.`)
    if (moving) {
        await symlink(destination, original, file ? 'file' : 'junction')
        progress.replacementId = await objectIdentity(original)
        progress.replacement = await snapshotRelocationLink(original, progress.replacementId, { kind: linkKind, payload: destination })
        if (!(await linksTo(original, destination))) throw new Error(`Could not verify the replacement link at ${original}.`)
    } else {
        await placeCopy(options, staging, original, file)
        progress.published = true
        if (file) await removeStagingAlias(plan, copy)
    }
    await verifyTree(finalRoot, output, finalRoot)
}

/** Reverse the recorded swap steps, newest first, verifying each object before touching it. */
async function undoSwap(plan: TransferPlan, progress: SwapProgress, error: unknown): Promise<void> {
    const { transfer, options, moving, liveIdentity, tracker, staging, aside, paths } = plan
    const { original, destination } = transfer
    const { forwardingAside } = tracker.record()
    const { copy, replacementId, replacement } = progress
    await paths.recheck()
    if (moving && replacementId !== undefined) {
        if ((await objectIdentity(original)) !== replacementId || !(await linksTo(original, destination))) throw new Error(`${original} changed.`, { cause: error })
        if (!replacement) throw new Error(`Could not verify the replacement at ${original}.`, { cause: error })
        await reclaimRelocationLinks([replacement], paths.parents())
    }
    if (progress.published && !moving && copy) await removeTree(original, copy, copy.entries[0]?.identity, undefined, undefined, { guards: paths.parents() })
    if (progress.setAside) {
        if ((await objectIdentity(aside)) !== liveIdentity) throw new Error(`${aside} changed.`, { cause: error })
        await moveEntry(options, aside, original)
    }
    if (progress.published && moving && copy) await removeTree(destination, copy, copy.entries[0]?.identity, undefined, undefined, { guards: paths.parents() })
    if (progress.forwardingMoved && forwardingAside && transfer.forwarding) {
        if ((await objectIdentity(forwardingAside)) !== transfer.forwarding.identity) throw new Error(`${forwardingAside} changed.`, { cause: error })
        await moveEntry(options, forwardingAside, destination)
    }
    if (await lstatIfPresent(staging)) {
        if (!copy) throw new Error(`Keep the partial copy at ${staging} for inspection.`, { cause: error })
        await removeTree(staging, copy, copy.entries[0]?.identity, undefined, undefined, { guards: paths.parents() })
    }
    await pruneEmptyParents(paths.created, transfer.base)
}

/** Release the retired copy and links under held handles, then record who owns the mirror. */
async function reclaimRetired(plan: TransferPlan, progress: SwapProgress): Promise<TransferResult> {
    const {
        transfer,
        options,
        moving,
        source,
        finalRoot,
        file,
        linkKind,
        manifest,
        originalLink,
        originalDescriptor,
        forwardingDescriptor,
        liveIdentity,
        ownsBacking,
        tracker,
        aside,
        paths
    } = plan
    const { original, destination } = transfer
    const { forwardingAside, backingAside } = tracker.record()
    const { copy, replacementId } = progress
    const verifiedIdentity = copy?.entries[0]?.identity
    if (!copy || !verifiedIdentity) throw new Error(`Missing verified copy at ${finalRoot}.`)
    const requireReplacementLink = async () => {
        if (moving && ((await objectIdentity(original)) !== replacementId || !(await linksTo(original, destination)))) throw new Error(`${original} changed before reclamation.`)
    }
    const verifySurvivor = async () => {
        await paths.recheckForSurvivor()
        const current = await verifyTree(finalRoot, copy, finalRoot)
        if (current.entries[0]?.identity !== verifiedIdentity || (await objectIdentity(finalRoot)) !== verifiedIdentity) throw new Error(`${finalRoot} changed during reclamation.`)
        await requireReplacementLink()
        await options.afterVerifyingSurvivor?.(tracker.record())
    }

    await tracker.enter(moving ? 'reclaiming' : 'releasing')
    await paths.recheck()
    await verifyTreeContents(finalRoot, copy, finalRoot, true)
    await requireReplacementLink()
    if ((await objectIdentity(aside)) !== liveIdentity) throw new Error(`${aside} changed before reclamation.`)
    let forwardingIdentity: string | undefined
    const guards: ReclamationGuard[] = [...paths.parents()]
    if (moving && replacementId) guards.push({ path: original, identity: replacementId, link: { kind: linkKind, payload: destination } })
    const retiringLinks: ReclamationEntry[] = []
    if (progress.forwardingMoved && forwardingAside && forwardingDescriptor) retiringLinks.push({ ...forwardingDescriptor, path: forwardingAside })
    let retiringTree: string | undefined = aside
    if (originalLink && originalDescriptor) {
        await verifyOriginalLink(aside, originalLink)
        await verifyTreeContents(source, manifest, source, true)
        retiringLinks.push({ ...originalDescriptor, path: aside })
        retiringTree = undefined
        if (backingAside) {
            // Preserve the previous mirror name for consumers after its backing copy is released.
            await moveEntry(options, source, backingAside)
            await symlink(original, source, file ? 'file' : 'junction')
            forwardingIdentity = await objectIdentity(source)
            if (canonicalPathKey(await storedLinkTarget(source)) !== canonicalPathKey(original) || canonicalPathKey(await realpath(source)) !== canonicalPathKey(finalRoot))
                throw new Error(`Could not verify the forwarding link at ${source}.`)
            guards.push({ path: source, identity: forwardingIdentity, link: { kind: linkKind, payload: original } })
            retiringTree = backingAside
        } else if (!moving && ownsBacking) retiringTree = destination
    }
    if (retiringTree) {
        await removeTree(
            retiringTree,
            manifest,
            manifest.entries[0]?.identity,
            verifySurvivor,
            { path: finalRoot, identity: verifiedIdentity },
            { guards, links: retiringLinks, failAfter: options.failReclamationAfter, survivorManifest: copy }
        )
    } else {
        await reclaimRelocationLinks(retiringLinks, guards, { path: finalRoot, manifest: copy }, verifySurvivor)
    }
    if ((await objectIdentity(finalRoot)) !== verifiedIdentity) throw new Error(`${finalRoot} changed during reclamation.`)
    await options.journal.setOwner(
        original,
        moving ? { path: destination, identity: verifiedIdentity } : forwardingIdentity ? { path: destination, identity: forwardingIdentity, forwarding: true } : null
    )
    if ((await objectIdentity(finalRoot)) !== verifiedIdentity) throw new Error(`${finalRoot} changed while recording ownership.`)
    if (!options.copiedFiles) return { files: manifest.files, bytes: manifest.bytes }
    const result = registerCopies(manifest, copy, finalRoot, options.copiedFiles, options.trackRootAlias)
    await options.recordAliases?.(options.copiedFiles)
    return result
}

/** Move or restore one verified filesystem object. Renaming the live entry aside preserves
 * the exact junction, file symlink or hard-link name for rollback until the swap is verified. */
async function transferPath(action: 'move' | 'restore', transfer: DirectoryTransfer, options: TransferOptions): Promise<TransferResult> {
    const plan = await prepareTransfer(action, transfer, options)
    const { id } = plan.tracker.record()
    await plan.tracker.enter('copying').catch(async (error) => {
        await options.journal.remove(id)
        throw error
    })
    const progress: SwapProgress = { published: false, forwardingMoved: false, setAside: false }
    try {
        await swapIntoPlace(plan, progress)
    } catch (error) {
        try {
            await undoSwap(plan, progress, error)
        } catch (undoError) {
            throw new IncompleteTransferError(
                `${action} of ${transfer.original} failed (${errorMessage(error)}). Recovery details are in ${options.journal.location}: ${errorMessage(undoError)}`,
                plan.tracker.record(),
                { cause: error }
            )
        }
        await options.journal.remove(id)
        throw error
    }
    let result: TransferResult
    try {
        result = await reclaimRetired(plan, progress)
    } catch (error) {
        throw new IncompleteTransferError(
            `${transfer.original} was swapped, but reclamation failed (${errorMessage(error)}). Recovery details are in ${options.journal.location}.`,
            plan.tracker.record(),
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
