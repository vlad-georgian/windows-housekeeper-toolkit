import type { BigIntStats } from 'node:fs'
import { chmod, readdir, rmdir, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../types.ts'
import { removeTreeAnchored } from './anchored-delete.ts'
import { measurePath } from './detect.ts'
import { canonicalPathKey, entryIdentity, hasErrorCode, hasIdentity, inspectCanonicalEntry, resolveTarget, resolveTargetGroup, UnverifiedPathError } from './paths.ts'

async function unlinkWithReadonlyFallback(path: string, stats: BigIntStats): Promise<void> {
    try {
        await unlink(path)
    } catch (error) {
        if (!hasErrorCode(error, 'EPERM')) throw error
        if (entryIdentity(await inspectCanonicalEntry(path, stats.nlink)) !== entryIdentity(stats)) {
            throw error
        }
        await chmod(path, 0o666)
        await unlink(path)
    }
}

async function removeFile(path: string, stats: BigIntStats, callbacks: RemovalCallbacks): Promise<number> {
    await unlinkWithReadonlyFallback(path, stats)
    const bytes = stats.nlink === 1n ? Number(stats.size) : 0
    await callbacks.onRemoved({
        kind: 'file',
        path,
        sizeBytes: bytes,
        modifiedAt: stats.mtime
    })
    return bytes
}

async function removePathRecursively(path: string, stats: BigIntStats, callbacks: RemovalCallbacks): Promise<{ entries: number; bytes: number }> {
    if (stats.isFile()) {
        const bytes = await removeFile(path, stats, callbacks)
        return { entries: 1, bytes }
    }

    let entries = 0
    let bytes = 0
    for (const name of await readdir(path)) {
        const child = resolve(path, name)
        const result = await removePathRecursively(child, await inspectCanonicalEntry(child), callbacks)
        entries += result.entries
        bytes += result.bytes
    }

    if (entryIdentity(await inspectCanonicalEntry(path)) !== entryIdentity(stats)) {
        throw new UnverifiedPathError(`${path} changed during removal.`)
    }
    await rmdir(path)
    await callbacks.onRemoved({
        kind: 'directory',
        path,
        sizeBytes: 0,
        modifiedAt: stats.mtime
    })
    return { entries: entries + 1, bytes }
}

export async function removeFilesystemCandidate(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
    if (candidate.kind !== 'filesystem' || !candidate.path || !candidate.allowedRoot || !candidate.canonicalPath || !candidate.filesystemIdentity) {
        throw new Error(`Candidate ${candidate.id} has no verified filesystem identity.`)
    }

    const group = await resolveTargetGroup(candidate.path, candidate.filesystemAliases ?? [], candidate.allowedRoot)
    const target = group.target
    if (canonicalPathKey(target.path) !== canonicalPathKey(candidate.canonicalPath) || !hasIdentity(target, candidate.filesystemIdentity)) {
        throw new UnverifiedPathError(`${candidate.path} changed after detection.`)
    }

    if (group.aliases.length > 0) {
        // Keep the primary entry until every alias is removed. Only the final unlink frees its bytes.
        const entries = [...group.aliases, target]
        let remaining = BigInt(entries.length)
        let reclaimedBytes = 0
        for (const entry of entries) {
            const stats = await inspectCanonicalEntry(entry.path, remaining)
            if (entryIdentity(stats) !== target.identity.target) {
                throw new UnverifiedPathError(`${entry.path} changed before removal.`)
            }
            reclaimedBytes += await removeFile(entry.path, stats, callbacks)
            remaining -= 1n
        }
        return { removedEntries: entries.length, reclaimedBytes }
    }

    // Verify the entire tree before starting so a new linked or inaccessible child prevents removal.
    await measurePath(target.path, target.stats, candidate.unlinkTreeLinks)
    const current = await resolveTarget(candidate.path, candidate.allowedRoot)
    if (canonicalPathKey(current.path) !== canonicalPathKey(target.path) || !hasIdentity(current, target.identity)) {
        throw new UnverifiedPathError(`${target.path} changed before removal.`)
    }

    if (candidate.unlinkTreeLinks) {
        // Path-based deletion cannot keep a parent swap from redirecting an unlink, so only handle-anchored removal is allowed.
        const anchored = await removeTreeAnchored(current.path, current.path, { dev: current.stats.dev, ino: current.stats.ino }, callbacks)
        return { removedEntries: anchored.entries, reclaimedBytes: anchored.bytes }
    }
    const result = await removePathRecursively(current.path, current.stats, callbacks)
    return { removedEntries: result.entries, reclaimedBytes: result.bytes }
}
