import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, chmod, copyFile, link as hardLink, lstat, mkdir, readdir, readlink, realpath, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { canonicalPathKey, entryIdentity, isPathInside } from '../core/filesystem/paths.ts'
import { readWindowsFilePermissions } from '../windows/file-permissions.ts'
import { reparsePointKind } from '../windows/kernel32.ts'
import { nativeEntryIdentity, readReparsePermissions, reclaimWindowsTree, type ReclamationEntry, type ReclamationGuard, type ReparseLink } from '../windows/reclaim-tree.ts'
import { inspectDirectoryPath, type DirectoryIdentity } from './directory-path.ts'

export class UnsupportedTreeError extends Error {}

interface TreeEntry {
    readonly path: string
    readonly identity: string
    readonly kind: 'file' | 'directory' | 'junction' | 'symlink'
    readonly bytes: number
    readonly links: number
    readonly hash: string | null
    readonly readOnly: boolean
    /** First in-tree name of the same file. */
    readonly alias: string | null
    /** Link payload, relative to the tree root for internal targets. */
    readonly target: string | null
    readonly internal: boolean
    readonly payload?: string
}

export interface TreeManifest {
    readonly root: string
    readonly permissions: readonly string[]
    readonly entries: readonly TreeEntry[]
    readonly bytes: number
    readonly files: number
}

export async function hashFile(path: string): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
    return hash.digest('hex')
}

/** Resolve internal hops through the physical copy even when their payloads name the final root. */
async function linkTargetStats(root: string, representedRoot: string, initialTarget: string) {
    let target = initialTarget
    const visited = new Set<string>()
    while (isPathInside(target, representedRoot)) {
        const key = canonicalPathKey(target)
        if (visited.has(key) || visited.size >= 63) throw new UnsupportedTreeError(`A link target in ${root} forms a cycle or has too many hops.`)
        visited.add(key)
        const components = relative(representedRoot, target).split(sep)
        let physical = root
        let index = 0
        for (const component of components) {
            physical = join(physical, component)
            const stats = await lstat(physical)
            index++
            if (stats.isSymbolicLink()) {
                const payload = await readlink(physical)
                const parent = join(representedRoot, relative(root, dirname(physical)))
                target = resolve(parent, payload, ...components.slice(index))
                break
            }
            if (index === components.length) return stats
            if (!stats.isDirectory()) throw new UnsupportedTreeError(`${physical} is not a directory.`)
        }
    }
    return stat(canonicalPathKey(target) === canonicalPathKey(representedRoot) ? root : target)
}

/** Relocation recreates junctions to directories and file symbolic links to files. Anything else is reported while planning. */
function supportedLinkKind(path: string, directoryTarget: boolean): 'junction' | 'symlink' {
    const kind = reparsePointKind(path)
    if (kind === 'junction' && directoryTarget) return 'junction'
    if (kind === 'file-symlink' && !directoryTarget) return 'symlink'
    const description =
        kind === 'directory-symlink'
            ? 'a directory symbolic link'
            : kind === 'file-symlink'
              ? 'a file symbolic link to a directory'
              : kind === 'junction'
                ? 'a junction to a file'
                : 'an unsupported reparse point'
    throw new UnsupportedTreeError(`${path} is ${description}. Only junctions to folders and file symbolic links to files can be relocated.`)
}

/** Inventory the root itself (which may be a launcher file), then its children without descending into links. */
async function inventory(root: string, representedRoot: string, hashContents: boolean): Promise<Omit<TreeManifest, 'permissions'>> {
    const entries: TreeEntry[] = []
    const seen = new Map<string, TreeEntry>()
    let bytes = 0
    let files = 0
    async function visit(path: string): Promise<void> {
        const absolute = join(root, path)
        const stats = await lstat(absolute, { bigint: true })
        const identity = entryIdentity(stats)
        const common = { path, identity, bytes: 0, links: 1, hash: null, readOnly: false, alias: null, target: null, internal: false }
        if (stats.isSymbolicLink()) {
            if (!path) throw new UnsupportedTreeError(`${absolute} is a link, not a physical transfer root.`)
            const raw = await readlink(absolute)
            const targetPath = resolve(dirname(join(representedRoot, path)), raw)
            const internal = isPathInside(targetPath, representedRoot)
            const target = internal ? relative(representedRoot, targetPath) : targetPath
            // A staging copy may contain a junction addressed to its final name. Inspect its counterpart in staging.
            const backing = await linkTargetStats(root, representedRoot, targetPath).catch(() => null)
            if (!backing || (!backing.isDirectory() && !backing.isFile())) throw new UnsupportedTreeError(`${absolute} is a link with an unavailable target.`)
            entries.push({ ...common, kind: supportedLinkKind(absolute, backing.isDirectory()), target, internal, payload: raw })
            return
        }
        if (canonicalPathKey(await realpath(absolute)) !== canonicalPathKey(absolute)) throw new UnsupportedTreeError(`${absolute} has a linked parent.`)
        if (stats.isDirectory()) {
            entries.push({ ...common, kind: 'directory' })
            for (const name of (await readdir(absolute)).toSorted()) await visit(join(path, name))
            return
        }
        if (!stats.isFile()) throw new UnsupportedTreeError(`${absolute} is not a regular file.`)
        const first = seen.get(identity)
        const readOnly = (stats.mode & 0o200n) === 0n
        if (readOnly && stats.nlink > 1n) throw new UnsupportedTreeError(`${absolute} has read-only hard links. Changing its attributes could affect another owner.`)
        const entry: TreeEntry = {
            ...common,
            kind: 'file',
            links: Number(stats.nlink),
            bytes: Number(stats.size),
            readOnly,
            alias: first?.path ?? null,
            hash: first?.hash ?? (hashContents ? await hashFile(absolute) : null)
        }
        entries.push(entry)
        if (!first) {
            seen.set(identity, entry)
            bytes += entry.bytes
            files++
        }
    }
    await visit('')
    return { root: representedRoot, entries, bytes, files }
}

function countFiles(manifest: Pick<TreeManifest, 'entries'>, seen: Set<string>): { bytes: number; files: number } {
    let bytes = 0
    let files = 0
    for (const entry of manifest.entries) {
        if (entry.kind !== 'file' || seen.has(entry.identity)) continue
        seen.add(entry.identity)
        bytes += entry.bytes
        files++
    }
    return { bytes, files }
}

export async function measureTree(root: string, seen = new Set<string>()): Promise<{ bytes: number; files: number }> {
    return countFiles(await inventory(root, root, false), seen)
}

/** A file with hard-link names outside the inventoried trees. */
export interface ExternalHardLink {
    /** The first name found inside the trees. */
    readonly path: string
    /** The trees that hold a name of this file. */
    readonly roots: readonly string[]
    readonly bytes: number
}

/**
 * Files under `roots` whose link count exceeds the names found under all of them. A copy on
 * another drive cannot keep those outside names linked to the moved data.
 */
export async function externalHardLinks(roots: readonly string[]): Promise<ExternalHardLink[]> {
    const files = new Map<string, { path: string; roots: Set<string>; links: number; names: number; bytes: number }>()
    for (const root of roots) {
        for (const entry of (await inventory(root, root, false)).entries) {
            if (entry.kind !== 'file' || entry.links < 2) continue
            const known = files.get(entry.identity)
            if (known) {
                known.names++
                known.roots.add(root)
            } else files.set(entry.identity, { path: join(root, entry.path), roots: new Set([root]), links: entry.links, names: 1, bytes: entry.bytes })
        }
    }
    return [...files.values()].filter((file) => file.links > file.names).map(({ path, roots: owners, bytes }) => ({ path, roots: [...owners], bytes }))
}

export async function snapshotTree(root: string): Promise<TreeManifest> {
    const manifest = await inventory(root, root, true)
    return { ...manifest, permissions: await readPermissions(root, manifest.entries) }
}

export async function verifyTreeContents(root: string, manifest: TreeManifest, representedRoot = manifest.root, sameObjects = false): Promise<TreeManifest> {
    const actual = await inventory(root, representedRoot, true)
    if (actual.entries.length !== manifest.entries.length) throw new Error(`Verification failed at ${root}: entry count changed.`)
    for (const [index, entry] of manifest.entries.entries()) {
        const other = actual.entries[index]
        if (!other || !sameContent(entry, other) || entry.target !== other.target || (sameObjects && (entry.identity !== other.identity || entry.payload !== other.payload))) {
            throw new Error(`Verification failed: ${join(root, entry.path)} differs.`)
        }
    }
    return { ...actual, permissions: manifest.permissions }
}

function sameContent(entry: TreeEntry, other: TreeEntry): boolean {
    return (
        entry.path === other.path &&
        entry.kind === other.kind &&
        entry.hash === other.hash &&
        entry.bytes === other.bytes &&
        entry.readOnly === other.readOnly &&
        entry.alias === other.alias &&
        entry.internal === other.internal
    )
}

/** A survivor manifest supplied by the caller must describe the retiring contents. Only an external link
 * target may differ, because planning can remap it to the relocated store. */
function requireCopyOf(retiring: TreeManifest, survivor: TreeManifest, root: string): void {
    const matches =
        retiring.entries.length === survivor.entries.length &&
        retiring.entries.every((entry, index) => {
            const other = survivor.entries[index]
            return other && sameContent(entry, other) && (entry.internal ? entry.target === other.target : (entry.target === null) === (other.target === null))
        })
    if (!matches) throw new Error(`The surviving copy at ${root} does not match the copy being reclaimed.`)
}

function reparseLink(entry: TreeEntry): ReparseLink | undefined {
    return entry.payload !== undefined && (entry.kind === 'junction' || entry.kind === 'symlink') ? { kind: entry.kind, payload: entry.payload } : undefined
}

async function readPermissions(root: string, entries: readonly TreeEntry[]): Promise<readonly string[]> {
    const paths = entries.flatMap((entry) => (entry.kind === 'file' || entry.kind === 'directory' ? [{ path: join(root, entry.path), kind: entry.kind }] : []))
    const links = entries.flatMap((entry) => {
        const link = reparseLink(entry)
        return link ? [{ path: join(root, entry.path), identity: entry.identity, link }] : []
    })
    const [physical, reparses] = await Promise.all([readWindowsFilePermissions(paths), readReparsePermissions(links)])
    let nextPhysical = 0
    let nextLink = 0
    return entries.map((entry) => {
        const permission = reparseLink(entry) ? reparses[nextLink++] : physical[nextPhysical++]
        if (!permission) throw new Error(`Could not verify permissions at ${join(root, entry.path)}.`)
        return permission
    })
}

async function verifyPermissions(root: string, manifest: TreeManifest, actual = manifest.entries): Promise<void> {
    const permissions = await readPermissions(root, actual)
    const index = permissions.findIndex((value, position) => value !== manifest.permissions[position])
    const changed = manifest.entries[index]
    if (changed) throw new Error(`Windows permissions differ at ${join(root, changed.path)}.`)
}

export async function verifyTree(root: string, manifest: TreeManifest, representedRoot = manifest.root): Promise<TreeManifest> {
    const verified = await verifyTreeContents(root, manifest, representedRoot)
    for (const entry of manifest.entries) {
        const path = join(root, entry.path)
        if (entry.kind === 'directory') {
            const probe = join(path, `.windows-housekeeper-toolkit-${randomUUID()}.probe`)
            try {
                await writeFile(probe, '', { flag: 'wx' })
                await unlink(probe)
            } catch (error) {
                throw new Error(`The current user cannot create and remove a test file in ${path}.`, { cause: error })
            }
        } else if (entry.kind === 'file' && !entry.readOnly) {
            const handle = await open(path, 'r+')
            await handle.close()
        }
    }
    await verifyPermissions(root, manifest, verified.entries)
    return verified
}

/** Across sibling roots, remember the identity and location of each published file. Revalidate the published
 * copy before linking a second name to it. */
export function remapExternalLinks(manifest: TreeManifest, mapping: ReadonlyMap<string, { from: string; to: string }> | undefined): TreeManifest {
    if (!mapping?.size) return manifest
    for (const path of mapping.keys()) {
        if (!manifest.entries.some((entry) => canonicalPathKey(join(manifest.root, entry.path)) === path)) throw new UnsupportedTreeError(`${path} disappeared after planning.`)
    }
    return {
        ...manifest,
        entries: manifest.entries.map((entry) => {
            const rule = mapping.get(canonicalPathKey(join(manifest.root, entry.path)))
            if (!rule) return entry
            if (entry.internal || entry.target === null || canonicalPathKey(entry.target) !== canonicalPathKey(rule.from))
                throw new UnsupportedTreeError(`${join(manifest.root, entry.path)} changed after planning.`)
            return Object.assign({}, entry, { target: rule.to })
        })
    }
}

/** A published copy of a hard-linked file, keyed by the source file's identity. */
export interface CopiedFile {
    readonly path: string
    readonly identity: string
}
export type CopiedFiles = Map<string, CopiedFile>
export async function copyTree(source: string, target: string, manifest: TreeManifest, finalRoot: string, previous?: CopiedFiles): Promise<string> {
    let rootIdentity: string | undefined
    for (const entry of manifest.entries) {
        const absolute = join(source, entry.path)
        const destination = join(target, entry.path)
        if (entryIdentity(await lstat(absolute, { bigint: true })) !== entry.identity) throw new Error(`${absolute} changed during relocation.`)
        if (entry.kind === 'directory') await mkdir(destination)
        else if (entry.target !== null) {
            await symlink(entry.internal ? join(finalRoot, entry.target) : entry.target, destination, entry.kind === 'junction' ? 'junction' : 'file')
        } else if (entry.alias !== null) await hardLink(join(target, entry.alias), destination)
        else {
            const prior = previous?.get(entry.identity)
            if (prior) {
                if (entryIdentity(await lstat(prior.path, { bigint: true })) !== prior.identity || canonicalPathKey(await realpath(prior.path)) !== canonicalPathKey(prior.path))
                    throw new Error(`Alias changed at ${prior.path}.`)
                await hardLink(prior.path, destination)
            } else {
                await copyFile(absolute, destination, constants.COPYFILE_EXCL)
                const stats = await lstat(absolute)
                await utimes(destination, stats.atime, stats.mtime)
                if (entry.readOnly) await chmod(destination, 0o444)
            }
        }
        if (!entry.path) rootIdentity = entryIdentity(await lstat(destination, { bigint: true }))
    }
    if (!rootIdentity) throw new Error(`Missing transfer root at ${target}.`)
    return rootIdentity
}

export function registerCopies(manifest: TreeManifest, copy: TreeManifest, finalRoot: string, previous: CopiedFiles, trackRoot = false): { bytes: number; files: number } {
    const result = countFiles(manifest, new Set(previous.keys()))
    for (const [index, entry] of manifest.entries.entries()) {
        const copied = copy.entries[index]
        if (entry.kind === 'file' && (entry.links > 1 || (trackRoot && !entry.path)) && copied && !previous.has(entry.identity))
            previous.set(entry.identity, { path: join(finalRoot, entry.path), identity: copied.identity })
    }
    return result
}

async function reclamationEntries(root: string, manifest: TreeManifest): Promise<ReclamationEntry[]> {
    const children = new Map<string, string[]>()
    for (const entry of manifest.entries) {
        if (!entry.path) continue
        const parent = dirname(entry.path)
        const names = children.get(parent) ?? []
        names.push(basename(entry.path))
        children.set(parent, names)
    }
    const entries: ReclamationEntry[] = []
    for (const [index, entry] of manifest.entries.entries()) {
        const path = join(root, entry.path)
        const stats = await lstat(path, { bigint: true })
        const link = reparseLink(entry)
        if (stats.isSymbolicLink() !== !!link || (entry.kind === 'file' && stats.nlink !== BigInt(entry.links)) || entryIdentity(stats) !== entry.identity) {
            throw new UnsupportedTreeError(`Cannot safely reclaim linked entry at ${path}.`)
        }
        const permissions = manifest.permissions[index]
        if (!permissions || stats.ino === 0n) throw new Error(`Cannot verify the entry at ${path}.`)
        entries.push({
            path,
            directory: entry.kind === 'directory' || entry.kind === 'junction',
            ...(link && { link }),
            ...nativeEntryIdentity(stats),
            hash: entry.hash,
            readOnly: entry.readOnly,
            links: entry.kind === 'file' ? entry.links : 1,
            permissions,
            children: children.get(entry.path || '.') ?? []
        })
    }
    return entries
}

/** Validate both physical copies under pinned handles before deleting the retiring entries. */
export async function removeTree(
    root: string,
    manifest: TreeManifest,
    identity?: string,
    verifySurvivor?: () => Promise<void>,
    survivor?: DirectoryIdentity,
    protection?: {
        readonly guards: readonly ReclamationGuard[]
        readonly failAfter?: number | undefined
        readonly links?: readonly ReclamationEntry[]
        readonly survivorManifest?: TreeManifest
    }
): Promise<void> {
    const guards = protection?.guards ?? [...(await inspectDirectoryPath(dirname(root))), ...(survivor ? await inspectDirectoryPath(dirname(survivor.path)) : [])]
    const verified = await verifyTreeContents(root, manifest, manifest.root, true)
    if (identity && verified.entries[0]?.identity !== identity) throw new Error(`The retiring copy at ${root} changed.`)
    await verifyPermissions(root, manifest, verified.entries)
    if (survivor && verified.entries.some((entry, index) => entry.links !== manifest.entries[index]?.links)) {
        throw new Error(`Hard-link membership changed at ${root} before reclamation.`)
    }
    const retiring = await reclamationEntries(root, verified)
    let retained: ReclamationEntry[] = []
    if (survivor) {
        const supplied = protection?.survivorManifest
        if (supplied) requireCopyOf(manifest, supplied, survivor.path)
        const survivorManifest = supplied ?? (await verifyTreeContents(survivor.path, manifest, survivor.path))
        if (survivorManifest.entries[0]?.identity !== survivor.identity) throw new Error(`The surviving copy at ${survivor.path} changed.`)
        retained = await reclamationEntries(survivor.path, survivorManifest)
    }
    await verifySurvivor?.()
    await reclaimWindowsTree([...(protection?.links ?? []), ...retiring], retained, guards, protection?.failAfter)
}

/** Capture the link itself before a swap. Its target is never consulted by this check. */
export async function snapshotRelocationLink(path: string, identity: string, link: ReparseLink): Promise<ReclamationEntry> {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isSymbolicLink() || stats.ino === 0n || entryIdentity(stats) !== identity) throw new Error(`The link at ${path} changed.`)
    const [permissions] = await readReparsePermissions([{ path, identity, link }])
    if (!permissions) throw new Error(`Could not verify link permissions at ${path}.`)
    return {
        path,
        directory: link.kind === 'junction',
        ...nativeEntryIdentity(stats),
        hash: null,
        readOnly: false,
        permissions,
        children: [],
        link
    }
}

export async function reclaimRelocationLinks(
    links: readonly ReclamationEntry[],
    guards: readonly ReclamationGuard[],
    survivor?: { path: string; manifest: TreeManifest },
    verifySurvivor?: () => Promise<void>
): Promise<void> {
    const retained = survivor ? await reclamationEntries(survivor.path, survivor.manifest) : []
    await verifySurvivor?.()
    await reclaimWindowsTree(links, retained, guards)
}

/** The publication added exactly one alias to the staged file's verified identity. */
export async function reclaimPublishedAlias(staging: string, published: string, staged: TreeManifest, guards: readonly ReclamationGuard[]): Promise<void> {
    const entry = staged.entries[0]
    if (staged.entries.length !== 1 || entry?.kind !== 'file') throw new Error('Missing staged file identity.')
    const aliases = { ...staged, entries: [{ ...entry, links: entry.links + 1 }] }
    await reclaimWindowsTree(await reclamationEntries(staging, aliases), await reclamationEntries(published, aliases), guards)
}
