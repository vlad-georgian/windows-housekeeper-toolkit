import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { RemovalCallbacks } from '../types.ts'
import { canonicalPathKey, UnverifiedPathError } from './paths.ts'
import {
    ACCESS_DELETE,
    ACCESS_READ_ATTRIBUTES,
    ACCESS_WRITE_ATTRIBUTES,
    closeHandle,
    handlesSupported,
    markForDeletion,
    type OpenedEntry,
    openEntry,
    SHARE_PINNED
} from './windows-handles.ts'

/**
 * Deletion of a tree that contains links, anchored to pinned handles.
 *
 * Node and Bun only delete by path. A path walk that checks a directory and then deletes its
 * children by name can be redirected if another process replaces that directory in between,
 * with a junction or with a different plain directory. This walk instead:
 *
 * - opens the root without following links, and requires it to be the object detected earlier
 *   (volume serial and file index) at the verified location;
 * - keeps a handle open on every directory from the root down to the one being emptied, opened
 *   without delete sharing, so Windows refuses to rename, replace, or delete any of them, or
 *   their ancestors, until the walk finishes;
 * - opens each child by name, without following it if it is a link, pinned the same way, and
 *   requires Windows to report it directly inside its parent's verified location;
 * - deletes each entry through the handle that was just verified, never by name.
 *
 * A directory therefore cannot be swapped between its check and its removal, and an entry cannot
 * be renamed out of the tree and then deleted elsewhere.
 *
 * Unsupported: Windows older than 10 1809, and any entry another process holds open with sharing
 * that conflicts with ours. Those fail the removal and leave the rest of the tree in place. A
 * failed or interrupted removal can leave a partly emptied release, which is no longer offered.
 */

export { handlesSupported as anchoredDeleteSupported }

export interface RootIdentity {
    /** Node's `dev` and `ino` for the root, as detected. */
    readonly dev: bigint
    readonly ino: bigint
}

const ACCESS = ACCESS_DELETE | ACCESS_READ_ATTRIBUTES | ACCESS_WRITE_ATTRIBUTES

function expectAt(entry: OpenedEntry, expected: string, path: string): void {
    if (canonicalPathKey(entry.location) !== canonicalPathKey(expected)) {
        throw new UnverifiedPathError(`${path} resolves outside the verified tree. Removal stopped.`)
    }
}

/** The handles a walk holds open. Each is closed exactly once, on success or when the walk fails. */
class Handles {
    private readonly open = new Set<bigint>()

    /** Opens an entry and confirms its location. The handle is closed if the check fails. */
    openVerified(path: string, expected: string): OpenedEntry {
        const entry = openEntry(path, ACCESS, SHARE_PINNED)
        this.open.add(entry.handle)
        try {
            expectAt(entry, expected, path)
            return entry
        } catch (error) {
            this.close(entry.handle)
            throw error
        }
    }

    close(handle: bigint): void {
        if (this.open.delete(handle)) closeHandle(handle)
    }

    closeAll(): void {
        for (const handle of this.open) closeHandle(handle)
        this.open.clear()
    }
}

async function removeEntry(handles: Handles, entry: OpenedEntry, path: string, expected: string, callbacks: RemovalCallbacks): Promise<{ entries: number; bytes: number }> {
    if (entry.kind !== 'directory') {
        // A link is deleted as an entry. Its target is never opened.
        markForDeletion(entry.handle, path)
        handles.close(entry.handle)
        await callbacks.onRemoved({ kind: entry.kind, path, sizeBytes: entry.sizeBytes, modifiedAt: entry.modifiedAt })
        return { entries: 1, bytes: entry.sizeBytes }
    }

    let entries = 0
    let bytes = 0
    // This handle stays open, and pins the directory, while its children are removed.
    for (const name of await readdir(path)) {
        const childPath = join(path, name)
        const child = handles.openVerified(childPath, join(expected, name))
        const removed = await removeEntry(handles, child, childPath, join(expected, name), callbacks)
        entries += removed.entries
        bytes += removed.bytes
    }
    markForDeletion(entry.handle, path)
    handles.close(entry.handle)
    await callbacks.onRemoved({ kind: 'directory', path, sizeBytes: 0, modifiedAt: entry.modifiedAt })
    return { entries: entries + 1, bytes }
}

/**
 * Removes a verified directory tree, unlinking links and hardlinked names without following them.
 * `canonicalPath` is the tree's resolved location and `identity` is the root detected there.
 */
export async function removeTreeAnchored(path: string, canonicalPath: string, identity: RootIdentity, callbacks: RemovalCallbacks): Promise<{ entries: number; bytes: number }> {
    const handles = new Handles()
    try {
        const root = handles.openVerified(path, canonicalPath)
        if (root.kind !== 'directory' || root.identity !== `${identity.dev}:${identity.ino}`) {
            throw new UnverifiedPathError(`${path} is not the directory that was detected. Removal stopped.`)
        }
        return await removeEntry(handles, root, path, canonicalPath, callbacks)
    } finally {
        handles.closeAll()
    }
}
