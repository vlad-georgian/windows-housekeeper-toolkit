import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { canonicalPathKey, isPathInside, isUnavailablePath } from '../../core/filesystem/index.ts'
import type { ProcessLister } from '../../windows/processes.ts'

/**
 * Executable paths of the running processes, including resolved link targets. Returns `null`
 * when the inventory is unavailable or cannot be trusted, so callers treat in-use state as
 * unverified and skip removal.
 *
 * Windows hides the path of processes that cannot be inspected, such as an elevated process
 * while this tool runs unelevated. Such a process only blocks verification when its name matches
 * `unreadablePathNames`, the names of the app's own executables. System processes without a path
 * cannot be running from a user-owned installation.
 */
export async function runningProcessPaths(listProcesses: ProcessLister, unreadablePathNames: RegExp): Promise<string[] | null> {
    try {
        const paths = new Set<string>()
        for (const entry of await listProcesses()) {
            if (entry.id === process.pid) continue
            if (!entry.path) {
                if (unreadablePathNames.test(entry.name)) return null
                continue
            }
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
    return processPaths.some((processPath) => canonicalPathKey(processPath) === canonicalPathKey(path) || isPathInside(processPath, path))
}
