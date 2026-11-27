import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { isPathInside, isUnavailablePath } from '../../core/filesystem/index.ts'
import type { ProcessLister } from './codex-installations.ts'

/**
 * Executable paths of every running process, including resolved link targets. Returns `null`
 * when the inventory is unavailable or a process path cannot be read, so callers can treat the
 * in-use state as unverified.
 */
export async function runningProcessPaths(listProcesses: ProcessLister): Promise<string[] | null> {
    try {
        const paths = new Set<string>()
        for (const entry of await listProcesses()) {
            if (entry.id === process.pid) continue
            // System processes expose no path and cannot be running from a user-owned install.
            if (!entry.path) continue
            if (!isAbsolute(entry.path)) return null
            paths.add(entry.path)
            try {
                paths.add(await realpath(entry.path))
            } catch (error) {
                if (!isUnavailablePath(error)) throw error
            }
        }
        return [...paths]
    } catch {
        return null
    }
}

/** Whether a running process is, or executes from inside, the given path. */
export function isPathInUse(path: string, processPaths: readonly string[]): boolean {
    return processPaths.some((processPath) => processPath.toLowerCase() === path.toLowerCase() || isPathInside(processPath, path))
}
