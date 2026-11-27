import { open } from 'node:fs/promises'

import { hasErrorCode } from '../../core/filesystem/paths.ts'

/**
 * Whether another process holds Vite+'s installation lock. Vite+ takes `<data>\.install.lock` with
 * an exclusive byte-range lock while it changes releases, `current`, or `.previous-version`.
 * Windows fails a read of the locked range, which tells us the lock is held without taking it.
 *
 * A missing lock file means no installer has run, so nothing holds it. Any other failure is
 * treated as held, so an unverifiable lock never allows removal.
 */
export async function isInstallLockHeld(lockPath: string): Promise<boolean> {
    let handle
    try {
        handle = await open(lockPath, 'r')
    } catch (error) {
        return !hasErrorCode(error, 'ENOENT', 'ENOTDIR')
    }
    try {
        await handle.read(Buffer.alloc(1), 0, 1, 0)
        return false
    } catch {
        return true
    } finally {
        await handle.close()
    }
}
