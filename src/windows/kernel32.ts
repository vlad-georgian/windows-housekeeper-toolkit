import { dlopen, FFIType } from 'bun:ffi'
import { lstat } from 'node:fs/promises'
import { win32 } from 'node:path'

import { hasErrorCode } from '../core/filesystem/paths.ts'

let library: ReturnType<typeof openKernel32> | undefined

function openKernel32() {
    return dlopen('kernel32.dll', {
        MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        FindFirstFileW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
        FindClose: { args: [FFIType.u64], returns: FFIType.i32 },
        GetLastError: { args: [], returns: FFIType.u32 },
        SetLastError: { args: [FFIType.u32], returns: FFIType.void }
    }).symbols
}

function kernel32() {
    library ??= openKernel32()
    return library
}

/**
 * A null-terminated UTF-16 path in the `\\?\` namespace. Windows skips its usual normalization there,
 * so the path is resolved first and accepts the same spellings as `node:fs`. Deep trees stay reachable.
 */
function wide(path: string): Uint8Array {
    return new Uint8Array(Buffer.from(`${win32.toNamespacedPath(win32.resolve(path))}\0`, 'utf16le'))
}

/** Win32 error codes the relocation steps can meet, with the Node code callers already branch on. */
const knownErrors: Readonly<Record<number, readonly [code: string, reason: string]>> = {
    2: ['ENOENT', 'not found'],
    3: ['ENOENT', 'path not found'],
    5: ['EPERM', 'access denied'],
    17: ['EXDEV', 'on a different volume'],
    32: ['EBUSY', 'in use by another process'],
    80: ['EEXIST', 'already exists'],
    183: ['EEXIST', 'already exists']
}

/**
 * Bun does not promise to keep the thread's last error between FFI calls, so it is cleared before each
 * call and read right after. Zero means it was lost, and the caller falls back to inspecting the paths.
 */
function lastError(): number {
    return kernel32().GetLastError()
}

function windowsError(message: string, error: number): Error {
    const [code, reason] = knownErrors[error] ?? [undefined, 'Windows error']
    return Object.assign(new Error(`${message}: ${reason} (${error}).`), { errno: error, ...(code && { code }) })
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
 * Node's `rename` asks Windows to replace an existing file, even when the source is a folder.
 * `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` fails instead, and it moves a reparse point
 * itself rather than its target.
 */
export async function moveExclusive(from: string, to: string): Promise<void> {
    const symbols = kernel32()
    symbols.SetLastError(0)
    if (symbols.MoveFileExW(wide(from), wide(to), 0)) return
    const error = lastError()
    const message = `Could not move ${from} to ${to}`
    if (error) throw windowsError(message, error)
    if (await present(to)) throw Object.assign(new Error(`${message}: ${to} already exists.`), { code: 'EEXIST' })
    throw new Error(`${message}.`)
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
    symbols.SetLastError(0)
    const handle = symbols.FindFirstFileW(wide(path), data)
    if (handle === invalidHandle) {
        const message = `Could not read the entry at ${path}`
        const error = lastError()
        throw error ? windowsError(message, error) : new Error(`${message}.`)
    }
    symbols.FindClose(handle)
    const view = new DataView(data.buffer)
    const attributes = view.getUint32(0, true)
    if (!(attributes & reparseAttribute)) return null
    const tag = view.getUint32(36, true)
    if (tag === mountPointTag) return 'junction'
    if (tag === symlinkTag) return attributes & directoryAttribute ? 'directory-symlink' : 'file-symlink'
    return 'other'
}
