import { dlopen, FFIType } from 'bun:ffi'
import { resolve } from 'node:path'

import { UnverifiedPathError } from './paths.ts'

/**
 * Handle-based file access for the few operations that path-based Node and Bun calls cannot make
 * safe. Every entry is opened without following a final link, and the location Windows reports for
 * the opened object is returned, so a caller can confirm it is the object it meant to open.
 *
 * Sharing never includes `FILE_SHARE_DELETE` here. While a handle from this module is open,
 * Windows refuses to rename, replace, or delete that entry, and refuses to rename its ancestors.
 * That pin is what keeps a verified directory from being swapped for another one.
 *
 * Windows 10 1809 or later is required. `handlesSupported` is false where the API cannot be loaded,
 * and callers must refuse the operation.
 */

export const ACCESS_DELETE = 0x00010000
export const ACCESS_READ_ATTRIBUTES = 0x80
export const ACCESS_WRITE_ATTRIBUTES = 0x100
export const ACCESS_READ = 0x80000000
export const ACCESS_WRITE = 0x40000000
/** Others may read and write, but never rename or delete, the opened entry. */
export const SHARE_PINNED = 0x1 | 0x2

const OPEN_EXISTING = 3
const FLAG_BACKUP_SEMANTICS = 0x02000000
const FLAG_OPEN_REPARSE_POINT = 0x00200000
const ATTRIBUTE_DIRECTORY = 0x10
const ATTRIBUTE_REPARSE_POINT = 0x400
const FILE_DISPOSITION_INFO_EX = 21
const DISPOSITION_DELETE = 0x1
const DISPOSITION_IGNORE_READONLY = 0x10
const LOCK_EXCLUSIVE = 0x2
const LOCK_FAIL_IMMEDIATELY = 0x1
const WHOLE_FILE = 0xffffffff
const INVALID_HANDLE = -1n

const symbols = {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    GetFinalPathNameByHandleW: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
    SetFileInformationByHandle: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
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

export const handlesSupported = kernel32 !== null

export interface OpenedEntry {
    readonly handle: bigint
    readonly kind: 'file' | 'directory' | 'link'
    /** The location Windows reports for the opened object, without the `\\?\` prefix. */
    readonly location: string
    /** Volume serial and file index, which match Node's `dev` and `ino` for the same object. */
    readonly identity: string
    readonly links: number
    readonly sizeBytes: number
    readonly modifiedAt: Date
}

function api(): Kernel32 {
    if (!kernel32) throw new UnverifiedPathError('Handle-based file access is not available on this system.')
    return kernel32
}

/** Opens an entry without following it if it is a link. The caller must close the handle. */
export function openEntry(path: string, access: number, share: number): OpenedEntry {
    const k = api()
    const name = Buffer.from(`\\\\?\\${resolve(path)}\0`, 'utf16le')
    const handle = k.CreateFileW(name, access, share, null, OPEN_EXISTING, FLAG_BACKUP_SEMANTICS | FLAG_OPEN_REPARSE_POINT, null)
    if (handle === INVALID_HANDLE) throw new UnverifiedPathError(`Could not open ${path} for verified access.`)
    try {
        const info = Buffer.alloc(52)
        if (!k.GetFileInformationByHandle(handle, info)) throw new UnverifiedPathError(`Could not read ${path}.`)
        const attributes = info.readUInt32LE(0)
        const buffer = Buffer.alloc(65_536)
        const length = k.GetFinalPathNameByHandleW(handle, buffer, buffer.length / 2, 0)
        if (length === 0 || length * 2 >= buffer.length) throw new UnverifiedPathError(`Could not resolve the location of ${path}.`)
        const kind = attributes & ATTRIBUTE_REPARSE_POINT ? 'link' : attributes & ATTRIBUTE_DIRECTORY ? 'directory' : 'file'
        const size = info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36)
        const written = (BigInt(info.readUInt32LE(24)) << 32n) | BigInt(info.readUInt32LE(20))
        const links = info.readUInt32LE(40)
        return {
            handle,
            kind,
            location: buffer.toString('utf16le', 0, length * 2).replace(/^\\\\\?\\/, ''),
            identity: `${info.readUInt32LE(28)}:${(BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48))}`,
            links,
            sizeBytes: kind === 'file' && links === 1 ? size : 0,
            modifiedAt: new Date(Number(written / 10_000n - 11_644_473_600_000n))
        }
    } catch (error) {
        k.CloseHandle(handle)
        throw error
    }
}

export function closeHandle(handle: bigint): void {
    api().CloseHandle(handle)
}

/** Marks the opened entry for deletion. It is removed when its last handle closes. Directories must be empty. */
export function markForDeletion(handle: bigint, path: string): void {
    const info = Buffer.alloc(4)
    info.writeUInt32LE(DISPOSITION_DELETE | DISPOSITION_IGNORE_READONLY)
    if (!api().SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO_EX, info, 4)) {
        throw new UnverifiedPathError(`Windows refused to remove ${path}. It may be in use or not empty.`)
    }
}

/** Takes an exclusive lock over the whole file without waiting. */
export function lockWholeFile(handle: bigint): boolean {
    return api().LockFileEx(handle, LOCK_EXCLUSIVE | LOCK_FAIL_IMMEDIATELY, 0, WHOLE_FILE, WHOLE_FILE, Buffer.alloc(32)) !== 0
}

export function unlockWholeFile(handle: bigint): void {
    api().UnlockFileEx(handle, 0, WHOLE_FILE, WHOLE_FILE, Buffer.alloc(32))
}
