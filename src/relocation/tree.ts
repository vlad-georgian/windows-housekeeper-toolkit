import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { readWindowsFilePermissions } from '../windows/file-permissions.ts'
import { nativeEntryIdentity, reclaimWindowsTree, type ReclamationEntry, type ReclamationGuard } from '../windows/reclaim-tree.ts'
import { type DirectoryIdentity, requireDirectoryIdentity } from './directory-path.ts'

/** A directory tree holds something relocation cannot copy faithfully yet, such as a link. */
export class UnsupportedTreeError extends Error {}

export interface TreeEntry {
    /** Path relative to the tree root. */
    readonly path: string
    readonly kind: 'file' | 'directory'
    readonly bytes: number
    /** Content hash of a file. */
    readonly sha256: string | null
    readonly readOnly: boolean
}

/** The verified contents of a directory tree. */
export interface TreeManifest {
    readonly entries: readonly TreeEntry[]
    readonly bytes: number
    readonly files: number
    /** Owner, group, and DACL, ordered by root and then tree entries. */
    readonly permissions: readonly string[]
}

async function hashFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
    return hash.digest('hex')
}

/** Walks a tree without following links. Links, hard-linked files, and special files are unsupported. */
async function walk(root: string, visit: (entry: Omit<TreeEntry, 'sha256'>, absolute: string) => Promise<void>, relative = ''): Promise<void> {
    for (const name of (await readdir(join(root, relative))).toSorted()) {
        const path = relative ? join(relative, name) : name
        const absolute = join(root, path)
        const stats = await lstat(absolute, { bigint: true })
        if (stats.isSymbolicLink()) throw new UnsupportedTreeError(`${absolute} is a link. Relocating directories that contain links is not supported yet.`)
        if (stats.isFile()) {
            if (stats.nlink !== 1n) throw new UnsupportedTreeError(`${absolute} is hard-linked. Relocating hard-linked files is not supported yet.`)
            await visit({ path, kind: 'file', bytes: Number(stats.size), readOnly: (stats.mode & 0o200n) === 0n }, absolute)
        } else if (stats.isDirectory()) {
            await visit({ path, kind: 'directory', bytes: 0, readOnly: false }, absolute)
            await walk(root, visit, path)
        } else {
            throw new UnsupportedTreeError(`${absolute} is not a regular file or directory.`)
        }
    }
}

async function requireDirectory(root: string): Promise<void> {
    const stats = await lstat(root)
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new UnsupportedTreeError(`${root} is not a plain directory.`)
}

/** Totals a tree's size without hashing it. */
export async function measureTree(root: string): Promise<{ bytes: number; files: number }> {
    await requireDirectory(root)
    let bytes = 0
    let files = 0
    await walk(root, async (entry) => {
        bytes += entry.bytes
        if (entry.kind === 'file') files++
    })
    return { bytes, files }
}

async function snapshotContents(root: string): Promise<Omit<TreeManifest, 'permissions'>> {
    await requireDirectory(root)
    const entries: TreeEntry[] = []
    await walk(root, async (entry, absolute) => {
        entries.push({ ...entry, sha256: entry.kind === 'file' ? await hashFile(absolute) : null })
    })
    const files = entries.filter((entry) => entry.kind === 'file')
    return { entries, bytes: files.reduce((total, entry) => total + entry.bytes, 0), files: files.length }
}

function permissionPaths(root: string, entries: readonly TreeEntry[]): { path: string; kind: TreeEntry['kind'] }[] {
    return [{ path: root, kind: 'directory' }, ...entries.map((entry) => ({ path: join(root, entry.path), kind: entry.kind }))]
}

/** Records contents, read-only flags, and Windows permissions of a plain directory tree. */
export async function snapshotTree(root: string): Promise<TreeManifest> {
    const contents = await snapshotContents(root)
    return { ...contents, permissions: await readWindowsFilePermissions(permissionPaths(root, contents.entries)) }
}

function describeDifference(expected: TreeManifest, actual: Omit<TreeManifest, 'permissions'>): string | null {
    const actualByPath = new Map(actual.entries.map((entry) => [entry.path.toLowerCase(), entry]))
    for (const entry of expected.entries) {
        const other = actualByPath.get(entry.path.toLowerCase())
        if (!other) return `${entry.path} is missing`
        if (other.kind !== entry.kind || other.bytes !== entry.bytes || other.sha256 !== entry.sha256) return `${entry.path} differs`
        if (other.readOnly !== entry.readOnly) return `${entry.path} has different permissions`
        actualByPath.delete(entry.path.toLowerCase())
    }
    const [extra] = actualByPath.values()
    return extra ? `${extra.path} is unexpected` : null
}

/** Throws unless the tree at `root` matches `manifest`. */
export async function verifyTreeContents(root: string, manifest: TreeManifest): Promise<void> {
    const difference = describeDifference(manifest, await snapshotContents(root))
    if (difference) throw new Error(`Verification failed at ${root}: ${difference}.`)
}

async function verifyTreePermissions(root: string, manifest: TreeManifest): Promise<void> {
    const paths = permissionPaths(root, manifest.entries)
    const permissions = await readWindowsFilePermissions(paths)
    for (const [index, { path }] of paths.entries()) {
        if (permissions[index] !== manifest.permissions[index]) throw new Error(`Windows permissions differ at ${path}.`)
    }
}

async function verifyDirectoryWrites(directory: string): Promise<void> {
    await requireDirectory(directory)
    const probe = join(directory, `.windows-housekeeper-toolkit-${randomUUID()}.probe`)
    try {
        await writeFile(probe, '', { flag: 'wx' })
        await unlink(probe)
    } catch (error) {
        throw new Error(`The current user cannot create and remove a test file in ${directory}.`, { cause: error })
    }
}

/** Verifies contents and tests actual write access, including Windows ACLs. */
export async function verifyTree(root: string, manifest: TreeManifest): Promise<void> {
    await verifyTreeContents(root, manifest)
    await verifyDirectoryWrites(root)
    for (const entry of manifest.entries) {
        const path = join(root, entry.path)
        if (entry.kind === 'directory') await verifyDirectoryWrites(path)
        else if (!entry.readOnly) {
            // The content check already read every file. Open for writing without modifying it.
            try {
                const handle = await open(path, 'r+')
                await handle.close()
            } catch (error) {
                throw new Error(`The current user cannot open ${path} for writing.`, { cause: error })
            }
        }
    }
    await verifyTreePermissions(root, manifest)
}

/** Copies a plain directory tree to a new `target`, preserving read-only flags and file times. */
export async function copyTree(source: string, target: string, onCreated?: () => Promise<void>): Promise<void> {
    await requireDirectory(source)
    await mkdir(target)
    await onCreated?.()
    await walk(source, async (entry, absolute) => {
        const destination = join(target, entry.path)
        if (entry.kind === 'directory') {
            await mkdir(destination)
            return
        }
        await copyFile(absolute, destination, constants.COPYFILE_EXCL)
        const stats = await lstat(absolute)
        await utimes(destination, stats.atime, stats.mtime)
        if (entry.readOnly) await chmod(destination, 0o444)
    })
}

async function reclamationEntries(root: string, manifest: TreeManifest): Promise<ReclamationEntry[]> {
    const children = new Map<string, string[]>()
    for (const entry of manifest.entries) {
        const path = join(root, entry.path)
        const parent = dirname(path)
        const names = children.get(parent) ?? []
        names.push(basename(path))
        children.set(parent, names)
    }
    const entries: ReclamationEntry[] = []
    for (const [index, { path, kind }] of permissionPaths(root, manifest.entries).entries()) {
        const stats = await lstat(path, { bigint: true })
        const entry = manifest.entries[index - 1]
        const permissions = manifest.permissions[index]
        if (!permissions || stats.ino === 0n || stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())) {
            throw new Error(`Cannot verify the entry at ${path}.`)
        }
        entries.push({
            path,
            directory: kind === 'directory',
            ...nativeEntryIdentity(stats),
            hash: entry?.sha256 ?? null,
            readOnly: entry?.readOnly ?? false,
            permissions,
            children: children.get(path) ?? []
        })
    }
    return entries
}

/** Verifies both trees again under write-denying handles, and deletes only the validated old entries. */
export async function removeTree(
    root: string,
    manifest: TreeManifest,
    identity?: string,
    verifySurvivor?: () => Promise<void>,
    survivor?: DirectoryIdentity,
    protection?: { readonly guards: readonly ReclamationGuard[]; readonly failAfter?: number | undefined }
): Promise<void> {
    if (identity !== undefined) await requireDirectoryIdentity(root, identity)
    await verifyTreeContents(root, manifest)
    await verifyTreePermissions(root, manifest)
    const retiring = await reclamationEntries(root, manifest)
    const retained = survivor ? await reclamationEntries(survivor.path, manifest) : []
    await verifySurvivor?.()
    if (identity !== undefined) await requireDirectoryIdentity(root, identity)
    if (survivor) await requireDirectoryIdentity(survivor.path, survivor.identity)
    await reclaimWindowsTree(retiring, retained, protection?.guards, protection?.failAfter)
}

/** Removes a tree of plain files and directories, clearing read-only flags. Refuses links. */
export async function removeVerifiedTree(root: string): Promise<void> {
    await requireDirectory(root)
    for (const name of await readdir(root)) {
        const path = join(root, name)
        const stats = await lstat(path)
        if (stats.isSymbolicLink()) throw new UnsupportedTreeError(`${path} became a link. It was left in place.`)
        if (stats.isDirectory()) {
            await removeVerifiedTree(path)
        } else {
            if ((stats.mode & 0o200) === 0) await chmod(path, 0o666)
            await unlink(path)
        }
    }
    await rmdir(root)
}
