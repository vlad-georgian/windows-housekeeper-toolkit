import { dlopen, FFIType } from 'bun:ffi'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { RemovalCallbacks } from '../types.ts'
import { canonicalPathKey, UnverifiedPathError } from './paths.ts'

/**
 * Deletion anchored to open handles, for trees that contain links.
 *
 * Node and Bun only delete by path. A path walk that checks a directory and then deletes its
 * children by name can be redirected if another process replaces that directory with a junction
 * between the check and the deletion. This module opens each entry itself, without following it
 * if it is a link, asks Windows where that opened object really is, and deletes through the same
 * handle only when it sits directly inside the parent location already verified. Replacing a
 * directory during the walk therefore makes the next entry resolve elsewhere, which stops the
 * removal instead of deleting outside the tree.
 *
 * Limit: the object checked is the object deleted, but it can still be renamed by another
 * process after the check. It is then deleted at its new location. It was inside the verified
 * tree when checked, so nothing that was outside the tree is ever removed. Windows 10 1809 or
 * later is required. Where the Windows API is unavailable, `anchoredDeleteSupported` is false and
 * callers must refuse removal.
 */

const DELETE = 0x00010000
const FILE_READ_ATTRIBUTES = 0x80
const FILE_WRITE_ATTRIBUTES = 0x100
const SHARE_ALL = 0x7
const OPEN_EXISTING = 3
const FLAG_BACKUP_SEMANTICS = 0x02000000
const FLAG_OPEN_REPARSE_POINT = 0x00200000
const ATTRIBUTE_DIRECTORY = 0x10
const ATTRIBUTE_REPARSE_POINT = 0x400
const FILE_DISPOSITION_INFO_EX = 21
const DISPOSITION_DELETE = 0x1
const DISPOSITION_IGNORE_READONLY = 0x10
const INVALID_HANDLE = -1n

const symbols = {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    GetFinalPathNameByHandleW: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
    SetFileInformationByHandle: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
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

export const anchoredDeleteSupported = kernel32 !== null

type EntryKind = 'file' | 'directory' | 'link'

interface OpenEntry {
    readonly handle: bigint
    readonly kind: EntryKind
    /** The location Windows reports for the opened object, without the `\\?\` prefix. */
    readonly location: string
    /** Bytes freed by deleting this name. Zero while other hardlinked names keep the content. */
    readonly sizeBytes: number
    readonly modifiedAt: Date
}

function api(): Kernel32 {
    if (!kernel32) throw new UnverifiedPathError('Handle-anchored deletion is not available on this system.')
    return kernel32
}

function open(path: string): OpenEntry {
    const k = api()
    const name = Buffer.from(`\\\\?\\${resolve(path)}\0`, 'utf16le')
    const handle = k.CreateFileW(name, DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES, SHARE_ALL, null, OPEN_EXISTING, FLAG_BACKUP_SEMANTICS | FLAG_OPEN_REPARSE_POINT, null)
    if (handle === INVALID_HANDLE) throw new UnverifiedPathError(`Could not open ${path} for verified removal.`)
    try {
        const info = Buffer.alloc(52)
        if (!k.GetFileInformationByHandle(handle, info)) throw new UnverifiedPathError(`Could not read ${path}.`)
        const attributes = info.readUInt32LE(0)
        const buffer = Buffer.alloc(65_536)
        const length = k.GetFinalPathNameByHandleW(handle, buffer, buffer.length / 2, 0)
        if (length === 0 || length * 2 >= buffer.length) throw new UnverifiedPathError(`Could not resolve the location of ${path}.`)
        const location = buffer.toString('utf16le', 0, length * 2).replace(/^\\\\\?\\/, '')
        const kind: EntryKind = attributes & ATTRIBUTE_REPARSE_POINT ? 'link' : attributes & ATTRIBUTE_DIRECTORY ? 'directory' : 'file'
        const size = info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36)
        const written = (BigInt(info.readUInt32LE(24)) << 32n) | BigInt(info.readUInt32LE(20))
        return {
            handle,
            kind,
            location,
            sizeBytes: kind === 'file' && info.readUInt32LE(40) === 1 ? size : 0,
            modifiedAt: new Date(Number(written / 10_000n - 11_644_473_600_000n))
        }
    } catch (error) {
        k.CloseHandle(handle)
        throw error
    }
}

function deleteAndClose(entry: OpenEntry, path: string): void {
    const k = api()
    try {
        const info = Buffer.alloc(4)
        info.writeUInt32LE(DISPOSITION_DELETE | DISPOSITION_IGNORE_READONLY)
        if (!k.SetFileInformationByHandle(entry.handle, FILE_DISPOSITION_INFO_EX, info, 4)) {
            throw new UnverifiedPathError(`Windows refused to remove ${path}. It may be in use or not empty.`)
        }
    } finally {
        k.CloseHandle(entry.handle)
    }
}

function expectAt(entry: OpenEntry, expected: string, path: string): void {
    if (canonicalPathKey(entry.location) !== canonicalPathKey(expected)) {
        api().CloseHandle(entry.handle)
        throw new UnverifiedPathError(`${path} resolves outside the verified tree. Removal stopped.`)
    }
}

async function removeEntry(path: string, expected: string, callbacks: RemovalCallbacks): Promise<{ entries: number; bytes: number }> {
    const entry = open(path)
    expectAt(entry, expected, path)
    if (entry.kind !== 'directory') {
        // A link is deleted as an entry. Its target is never opened.
        deleteAndClose(entry, path)
        await callbacks.onRemoved({ kind: entry.kind, path, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt })
        return { entries: 1, bytes: entry.sizeBytes }
    }
    api().CloseHandle(entry.handle)

    let entries = 0
    let bytes = 0
    for (const name of await readdir(path)) {
        const removed = await removeEntry(join(path, name), join(expected, name), callbacks)
        entries += removed.entries
        bytes += removed.bytes
    }
    // Reopen to confirm the directory is still the verified one before deleting it.
    const directory = open(path)
    expectAt(directory, expected, path)
    if (directory.kind !== 'directory') {
        api().CloseHandle(directory.handle)
        throw new UnverifiedPathError(`${path} changed during removal.`)
    }
    deleteAndClose(directory, path)
    await callbacks.onRemoved({ kind: 'directory', path, sizeBytes: 0, modifiedAt: directory.modifiedAt })
    return { entries: entries + 1, bytes }
}

/**
 * Removes a verified directory tree, unlinking links and hardlinked names without following
 * them. `canonicalPath` is the tree's resolved location. Every entry must resolve directly below it.
 */
export async function removeTreeAnchored(path: string, canonicalPath: string, callbacks: RemovalCallbacks): Promise<{ entries: number; bytes: number }> {
    api()
    return removeEntry(path, canonicalPath, callbacks)
}
