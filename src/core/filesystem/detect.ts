import type { BigIntStats } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { CleanupCandidate } from '../types.ts'
import { inspectCanonicalEntry, isUnavailablePath, resolveTargetGroup, UnverifiedPathError } from './paths.ts'

export async function measurePath(path: string, stats: BigIntStats): Promise<{ sizeBytes: number; fileCount: number }> {
    if (stats.isFile()) return { sizeBytes: Number(stats.size), fileCount: 1 }

    let sizeBytes = 0
    let fileCount = 0
    for (const name of await readdir(path)) {
        const child = resolve(path, name)
        const measurement = await measurePath(child, await inspectCanonicalEntry(child))
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
}): Promise<CleanupCandidate | null> {
    const path = resolve(options.path)
    const allowedRoot = resolve(options.allowedRoot)
    try {
        const aliases = options.aliases?.map((alias) => resolve(alias)) ?? []
        const { target } = await resolveTargetGroup(path, aliases, allowedRoot)
        if ((options.type === 'file' && !target.stats.isFile()) || (options.type === 'directory' && !target.stats.isDirectory())) {
            return null
        }

        const measurement = await measurePath(target.path, target.stats)
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
            ...(aliases.length > 0 && { filesystemAliases: aliases })
        }
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return null
        throw error
    }
}
