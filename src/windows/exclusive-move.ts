import { dlopen, FFIType, ptr } from 'bun:ffi'
import { lstat } from 'node:fs/promises'

import { hasErrorCode } from '../core/filesystem/paths.ts'

let kernel32: ReturnType<typeof openKernel32> | undefined

function openKernel32() {
    return dlopen('kernel32.dll', { MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } })
}

function wide(path: string): Buffer {
    return Buffer.from(`${path}\0`, 'utf16le')
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
    kernel32 ??= openKernel32()
    const source = wide(from)
    const target = wide(to)
    if (kernel32.symbols.MoveFileExW(ptr(source), ptr(target), 0)) return
    if (await present(to)) throw Object.assign(new Error(`${to} already exists.`), { code: 'EEXIST' })
    throw new Error(`Could not move ${from} to ${to}.`)
}
