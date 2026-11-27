import { dlopen, FFIType } from 'bun:ffi'

/**
 * Vite+'s installation lock. Releases from 1.7.0 take `<data>\.install.lock` with an exclusive
 * whole-file lock while they change releases, `current`, or `.previous-version`, including during
 * `vp upgrade --rollback`. Holding the same lock while we read that metadata and remove a release
 * keeps a rollback from swapping the release under us.
 *
 * The lock is only taken without waiting. A lock that is held, missing, or unavailable returns
 * `null`, and callers must treat the metadata as unverified.
 */

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const SHARE_ALL = 0x7
const OPEN_EXISTING = 3
const LOCK_EXCLUSIVE = 0x2
const LOCK_FAIL_IMMEDIATELY = 0x1
const INVALID_HANDLE = -1n
const WHOLE_FILE = 0xffffffff

const symbols = {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    LockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UnlockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 }
} as const

type Kernel32 = ReturnType<typeof dlopen<typeof symbols>>['symbols']

function load(): Kernel32 | null {
    if (process.platform !== 'win32') return null
    try {
        return dlopen('kernel32.dll', symbols).symbols
    } catch {
        return null
    }
}

const kernel32 = load()

/** Takes the lock if it is free. Returns a function that releases it, or `null` if it could not be taken. */
export type InstallLockAcquirer = (lockPath: string) => Promise<(() => void) | null>

export const acquireInstallLock: InstallLockAcquirer = async (lockPath) => {
    if (!kernel32) return null
    const name = Buffer.from(`\\\\?\\${lockPath}\0`, 'utf16le')
    const handle = kernel32.CreateFileW(name, GENERIC_READ | GENERIC_WRITE, SHARE_ALL, null, OPEN_EXISTING, 0, null)
    // A missing lock file means no lock-aware Vite+ has changed this directory. Never create one.
    if (handle === INVALID_HANDLE) return null
    const overlapped = Buffer.alloc(32)
    if (!kernel32.LockFileEx(handle, LOCK_EXCLUSIVE | LOCK_FAIL_IMMEDIATELY, 0, WHOLE_FILE, WHOLE_FILE, overlapped)) {
        kernel32.CloseHandle(handle)
        return null
    }
    let released = false
    return () => {
        if (released) return
        released = true
        kernel32.UnlockFileEx(handle, 0, WHOLE_FILE, WHOLE_FILE, Buffer.alloc(32))
        kernel32.CloseHandle(handle)
    }
}
