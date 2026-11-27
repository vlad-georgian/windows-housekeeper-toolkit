import type { BigIntStats } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { CleanupCandidate } from '../types.ts'
import { inspectCanonicalEntry, inspectTreeEntry, isUnavailablePath, resolveTargetGroup, UnverifiedPathError } from './paths.ts'

/**
 * Measures a verified entry. With `unlinkTreeLinks`, links below the entry count as one entry
 * without being followed, and hardlinked files add no bytes because the other names keep them.
 */
export async function measurePath(path: string, stats: BigIntStats, unlinkTreeLinks = false): Promise<{ sizeBytes: number; fileCount: number }> {
    if (stats.isFile()) return { sizeBytes: unlinkTreeLinks && stats.nlink > 1n ? 0 : Number(stats.size), fileCount: 1 }

    let sizeBytes = 0
    let fileCount = 0
    for (const name of await readdir(path)) {
        const child = resolve(path, name)
        const childStats = unlinkTreeLinks ? await inspectTreeEntry(child) : await inspectCanonicalEntry(child)
        if (childStats.isSymbolicLink()) {
            fileCount += 1
            continue
        }
        const measurement = await measurePath(child, childStats, unlinkTreeLinks)
        sizeBytes += measurement.sizeBytes
        fileCount += measurement.fileCount
    }

    return { sizeBytes, fileCount }
}

export async function createFilesystemCandidate(options: {
    readonly id: string
    readonly path: string
    readonly allowedRoot: string
    readonly displayName: string
    readonly reason: string
    readonly type?: 'file' | 'directory'
    readonly aliases?: readonly string[]
    /** Unlink links and hardlinked files inside the tree instead of rejecting it. See `CleanupCandidate`. */
    readonly unlinkTreeLinks?: boolean
}): Promise<CleanupCandidate | null> {
    const path = resolve(options.path)
    const allowedRoot = resolve(options.allowedRoot)
    try {
        const aliases = options.aliases?.map((alias) => resolve(alias)) ?? []
        const { target } = await resolveTargetGroup(path, aliases, allowedRoot)
        if ((options.type === 'file' && !target.stats.isFile()) || (options.type === 'directory' && !target.stats.isDirectory())) {
            return null
        }

        const measurement = await measurePath(target.path, target.stats, options.unlinkTreeLinks)
        return {
            id: options.id,
            kind: 'filesystem',
            displayName: options.displayName,
            reason: options.reason,
            sizeBytes: measurement.sizeBytes,
            fileCount: measurement.fileCount,
            modifiedAt: target.stats.mtime,
            path,
            allowedRoot,
            canonicalPath: target.path,
            filesystemIdentity: target.identity,
            ...(aliases.length > 0 && { filesystemAliases: aliases }),
            ...(options.unlinkTreeLinks && { unlinkTreeLinks: true })
        }
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return null
        throw error
    }
}
