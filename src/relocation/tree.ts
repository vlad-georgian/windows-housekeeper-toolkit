import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, readdir, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
        if (stats.isSymbolicLink()) throw new UnsupportedTreeError(`${absolute} is a link. Moving trees that contain links is not supported yet.`)
        if (stats.isFile()) {
            if (stats.nlink !== 1n) throw new UnsupportedTreeError(`${absolute} is hard-linked. Moving hard-linked files is not supported yet.`)
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

/** Records every entry of a plain directory tree, with file content hashes. */
export async function snapshotTree(root: string): Promise<TreeManifest> {
    await requireDirectory(root)
    const entries: TreeEntry[] = []
    await walk(root, async (entry, absolute) => {
        entries.push({ ...entry, sha256: entry.kind === 'file' ? await hashFile(absolute) : null })
    })
    const files = entries.filter((entry) => entry.kind === 'file')
    return { entries, bytes: files.reduce((total, entry) => total + entry.bytes, 0), files: files.length }
}

function describeDifference(expected: TreeManifest, actual: TreeManifest): string | null {
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
    const difference = describeDifference(manifest, await snapshotTree(root))
    if (difference) throw new Error(`Verification failed at ${root}: ${difference}.`)
}

/**
 * Throws unless the tree at `root` matches `manifest` and the current user can use it: every
 * directory accepts writes and every file can be read, or written when it is not read-only.
 */
export async function verifyTree(root: string, manifest: TreeManifest): Promise<void> {
    await verifyTreeContents(root, manifest)
    const probe = join(root, `.windows-housekeeper-toolkit-${randomUUID()}.probe`)
    try {
        await writeFile(probe, '', { flag: 'wx' })
    } catch (error) {
        throw new Error(`The current user cannot write to ${root}.`, { cause: error })
    }
    await unlink(probe)
    for (const entry of manifest.entries) {
        const mode = entry.kind === 'directory' || !entry.readOnly ? constants.R_OK | constants.W_OK : constants.R_OK
        try {
            await access(join(root, entry.path), mode)
        } catch (error) {
            throw new Error(`The current user cannot use ${join(root, entry.path)}.`, { cause: error })
        }
    }
}

/** Copies a plain directory tree to a new `target`, preserving read-only flags and file times. */
export async function copyTree(source: string, target: string): Promise<void> {
    await requireDirectory(source)
    await mkdir(target)
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

/** Removes a tree after verifying it still matches `manifest`, so no unexpected data is lost. */
export async function removeTree(root: string, manifest: TreeManifest): Promise<void> {
    await verifyTreeContents(root, manifest)
    await removeVerifiedTree(root)
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
