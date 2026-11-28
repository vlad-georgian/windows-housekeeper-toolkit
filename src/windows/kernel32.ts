import { dlopen, FFIType, ptr } from 'bun:ffi'
import { lstat } from 'node:fs/promises'

import { hasErrorCode } from '../core/filesystem/paths.ts'

let library: ReturnType<typeof openKernel32> | undefined

function openKernel32() {
    return dlopen('kernel32.dll', {
        MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        FindFirstFileW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
        FindClose: { args: [FFIType.u64], returns: FFIType.i32 }
    }).symbols
}

function kernel32() {
    library ??= openKernel32()
    return library
}

/** A null-terminated UTF-16 path. Drive paths get the long-path prefix so deep trees stay reachable. */
function wide(path: string): Uint8Array {
    return new Uint8Array(Buffer.from(`${/^[A-Za-z]:\\/u.test(path) ? `\\\\?\\${path}` : path}\0`, 'utf16le'))
}

async function present(path: string): Promise<boolean> {
    try {
        await lstat(path)
        return true
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return false
        throw error
    }
}

/**
 * Renames a file, directory or link on the same volume without ever replacing the target.
 * Node's `rename` asks Windows to replace an existing file. `MoveFileExW` without
 * `MOVEFILE_REPLACE_EXISTING` fails instead, and it moves a reparse point itself rather than its target.
 */
export async function moveExclusive(from: string, to: string): Promise<void> {
    if (kernel32().MoveFileExW(ptr(wide(from)), ptr(wide(to)), 0)) return
    if (await present(to)) throw Object.assign(new Error(`${to} already exists.`), { code: 'EEXIST' })
    throw new Error(`Could not move ${from} to ${to}.`)
}

const invalidHandle = 0xffff_ffff_ffff_ffffn
const directoryAttribute = 0x10
const reparseAttribute = 0x400
const mountPointTag = 0xa000_0003
const symlinkTag = 0xa000_000c

/** What Windows stores at a path, read from the entry itself without following it. Node reports all of these as symbolic links. */
export type ReparsePointKind = 'junction' | 'directory-symlink' | 'file-symlink' | 'other'

export function reparsePointKind(path: string): ReparsePointKind | null {
    // WIN32_FIND_DATAW: attributes at offset 0, the reparse tag (dwReserved0) at offset 36.
    const data = new Uint8Array(592)
    const symbols = kernel32()
    const handle = symbols.FindFirstFileW(ptr(wide(path)), ptr(data))
    if (handle === invalidHandle) throw new Error(`Could not read the entry at ${path}.`)
    symbols.FindClose(handle)
    const view = new DataView(data.buffer)
    const attributes = view.getUint32(0, true)
    if (!(attributes & reparseAttribute)) return null
    const tag = view.getUint32(36, true)
    if (tag === mountPointTag) return 'junction'
    if (tag === symlinkTag) return attributes & directoryAttribute ? 'directory-symlink' : 'file-symlink'
    return 'other'
}
