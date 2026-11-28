import { join } from 'node:path'

import { canonicalPathKey } from '../../core/filesystem/index.ts'
import {
    ACCESS_READ,
    ACCESS_READ_ATTRIBUTES,
    ACCESS_WRITE,
    closeHandle,
    handlesSupported,
    lockWholeFile,
    openEntry,
    SHARE_PINNED,
    unlockWholeFile
} from '../../core/filesystem/windows-handles.ts'

/**
 * Vite+'s installation lock. Releases from 1.7.0 take `<data>\.install.lock` with an exclusive
 * whole-file lock while they change releases, `current`, or `.previous-version`, including during
 * `vp upgrade --rollback`. Holding the same lock while we read that metadata and remove a release
 * keeps a rollback from swapping the release under us.
 *
 * The caller passes the store's canonical directory, resolved once. This module then pins that
 * exact directory and lock file:
 *
 * - the directory is held open without delete sharing, so Windows refuses to rename or replace
 *   it, or any ancestor, until the lock is released;
 * - the lock is opened without following a final link and must be an ordinary file whose resolved
 *   location is directly inside that directory, and it is held without delete sharing too.
 *
 * Callers must use only the canonical directory they passed in while holding the lock. The lock is
 * only taken without waiting. A lock that is held, missing, linked, or unavailable returns `null`,
 * and callers must treat the metadata as unverified. The lock file is never created.
 */
export type InstallLockAcquirer = (storeDirectory: string) => Promise<(() => void) | null>

export const acquireInstallLock: InstallLockAcquirer = async (storeDirectory) => {
    if (!handlesSupported) return null
    const opened: bigint[] = []
    const fail = (): null => {
        for (const handle of opened) closeHandle(handle)
        return null
    }
    try {
        const directory = openEntry(storeDirectory, ACCESS_READ_ATTRIBUTES, SHARE_PINNED)
        opened.push(directory.handle)
        if (directory.kind !== 'directory' || canonicalPathKey(directory.location) !== canonicalPathKey(storeDirectory)) return fail()
        const lockPath = join(storeDirectory, '.install.lock')
        const lock = openEntry(lockPath, ACCESS_READ | ACCESS_WRITE, SHARE_PINNED)
        opened.push(lock.handle)
        if (lock.kind !== 'file' || canonicalPathKey(lock.location) !== canonicalPathKey(lockPath) || !lockWholeFile(lock.handle)) return fail()
        let released = false
        return () => {
            if (released) return
            released = true
            unlockWholeFile(lock.handle)
            for (const handle of opened.toReversed()) closeHandle(handle)
        }
    } catch {
        return fail()
    }
}
