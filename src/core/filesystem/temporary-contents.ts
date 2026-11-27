import type { Stats } from 'node:fs'
import { chmod, lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../types.ts'
import { canonicalPathKey, entryIdentity, hasErrorCode, isPathInside, UnverifiedPathError } from './paths.ts'

/**
 * Deletion primitives for temporary-directory cleanup. Tests substitute these to simulate
 * entries that Windows refuses to delete because another process holds them open.
 */
export interface ContentsOperations {
    unlink(path: string): Promise<void>
    rmdir(path: string): Promise<void>
}

export const defaultContentsOperations: ContentsOperations = {
    async unlink(path) {
        try {
            await unlink(path)
        } catch (error) {
            if (!hasErrorCode(error, 'EPERM')) throw error
            // A read-only attribute also reports EPERM. Retry once without it.
            await chmod(path, 0o666)
            await unlink(path)
        }
    },
    rmdir
}

async function canonicalOrResolved(path: string): Promise<string> {
    try {
        return await realpath(path)
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return path
        throw error
    }
}

async function measureContents(path: string): Promise<{ sizeBytes: number; fileCount: number }> {
    let sizeBytes = 0
    let fileCount = 0
    let names: string[]
    try {
        names = await readdir(path)
    } catch {
        return { sizeBytes, fileCount }
    }
    for (const name of names) {
        const child = join(path, name)
        let stats: Stats
        try {
            stats = await lstat(child)
        } catch {
            continue
        }
        if (stats.isDirectory()) {
            const nested = await measureContents(child)
            sizeBytes += nested.sizeBytes
            fileCount += nested.fileCount
        } else {
            fileCount += 1
            if (stats.isFile() && stats.nlink === 1) sizeBytes += stats.size
        }
    }
    return { sizeBytes, fileCount }
}

/**
 * Offers the contents of one temporary directory as a single candidate, keeping the directory.
 *
 * The directory qualifies only when it is a real directory (not a link) inside `within`, and
 * it neither equals nor contains any protected path. Machine-wide temporary folders and a
 * `TEMP` that points at a profile root therefore never qualify. Returns null when the
 * directory is missing, unverifiable, or empty.
 */
export async function createContentsCandidate(options: {
    readonly id: string
    readonly root: string
    readonly within: string
    readonly protectedPaths: readonly string[]
    readonly displayName: string
    readonly reason: string
}): Promise<CleanupCandidate | null> {
    try {
        const stats = await lstat(options.root, { bigint: true })
        if (!stats.isDirectory()) return null
        const canonicalRoot = await realpath(options.root)
        if (!isPathInside(canonicalRoot, await canonicalOrResolved(options.within))) return null
        for (const protectedPath of options.protectedPaths) {
            const canonicalProtected = await canonicalOrResolved(protectedPath)
            if (canonicalPathKey(canonicalProtected) === canonicalPathKey(canonicalRoot) || isPathInside(canonicalProtected, canonicalRoot)) return null
        }
        if ((await readdir(canonicalRoot)).length === 0) return null

        const measurement = await measureContents(canonicalRoot)
        const identity = entryIdentity(stats)
        return {
            id: options.id,
            kind: 'filesystem',
            displayName: options.displayName,
            reason: options.reason,
            sizeBytes: measurement.sizeBytes,
            fileCount: measurement.fileCount,
            modifiedAt: new Date(Number(stats.mtimeMs)),
            path: options.root,
            allowedRoot: canonicalRoot,
            canonicalPath: canonicalRoot,
            filesystemIdentity: { target: identity, allowedRoot: identity }
        }
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY', 'ELOOP')) return null
        throw error
    }
}

interface Run {
    readonly callbacks: RemovalCallbacks
    readonly operations: ContentsOperations
    removedEntries: number
    reclaimedBytes: number
    skippedEntries: number
}

function describeFailure(error: unknown): string {
    if (error instanceof Error) {
        const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : ''
        return `${code}${error.message}`
    }
    return String(error)
}

async function skip(run: Run, path: string, error: unknown): Promise<void> {
    run.skippedEntries += 1
    await run.callbacks.onSkipped?.({ path, reason: describeFailure(error) })
}

async function removed(run: Run, kind: 'file' | 'directory' | 'link', path: string, stats: Stats, bytes: number): Promise<void> {
    run.removedEntries += 1
    run.reclaimedBytes += bytes
    await run.callbacks.onRemoved({ kind, path, sizeBytes: bytes, modifiedAt: stats.mtime })
}

async function removeLink(run: Run, path: string, stats: Stats): Promise<void> {
    try {
        try {
            await run.operations.unlink(path)
        } catch {
            // Directory links such as junctions can need a directory removal. This removes only
            // the link, never its target.
            await run.operations.rmdir(path)
        }
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return
        await skip(run, path, error)
        return
    }
    await removed(run, 'link', path, stats, 0)
}

async function removeDirectory(run: Run, path: string, stats: Stats): Promise<void> {
    // Refuse to descend if a link replaced the directory since it was listed.
    if (canonicalPathKey(await realpath(path)) !== canonicalPathKey(path)) {
        throw new UnverifiedPathError(`${path} redirects outside its expected cleanup location.`)
    }
    const skippedBefore = run.skippedEntries
    for (const name of await readdir(path)) await removeEntry(run, join(path, name))
    try {
        await run.operations.rmdir(path)
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return
        // A directory kept because of a skipped child is already explained by that child.
        if (!(hasErrorCode(error, 'ENOTEMPTY', 'EEXIST') && run.skippedEntries > skippedBefore)) await skip(run, path, error)
        return
    }
    await removed(run, 'directory', path, stats, 0)
}

async function removeEntry(run: Run, path: string): Promise<void> {
    try {
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) {
            await removeLink(run, path, stats)
        } else if (stats.isDirectory()) {
            await removeDirectory(run, path, stats)
        } else {
            await run.operations.unlink(path)
            await removed(run, 'file', path, stats, stats.nlink === 1 ? stats.size : 0)
        }
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return
        await skip(run, path, error)
    }
}

/**
 * Removes everything inside the candidate's directory and keeps the directory. Links are
 * removed, never followed. Entries that are locked, in use, or inaccessible are reported as
 * skipped and the sibling entries still go.
 */
export async function removeContentsCandidate(
    candidate: CleanupCandidate,
    callbacks: RemovalCallbacks,
    operations: ContentsOperations = defaultContentsOperations
): Promise<RemovalResult> {
    if (candidate.kind !== 'filesystem' || !candidate.path || !candidate.canonicalPath || !candidate.filesystemIdentity) {
        throw new Error(`Candidate ${candidate.id} has no verified filesystem identity.`)
    }
    const stats = await lstat(candidate.path, { bigint: true })
    if (
        !stats.isDirectory() ||
        entryIdentity(stats) !== candidate.filesystemIdentity.target ||
        canonicalPathKey(await realpath(candidate.path)) !== canonicalPathKey(candidate.canonicalPath)
    ) {
        throw new UnverifiedPathError(`${candidate.path} changed after detection.`)
    }

    const run: Run = { callbacks, operations, removedEntries: 0, reclaimedBytes: 0, skippedEntries: 0 }
    for (const name of await readdir(candidate.canonicalPath)) await removeEntry(run, join(candidate.canonicalPath, name))
    return { removedEntries: run.removedEntries, reclaimedBytes: run.reclaimedBytes }
}
