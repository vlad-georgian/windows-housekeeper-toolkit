import type { BigIntStats } from 'node:fs'
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

import {
    canonicalPathKey,
    hasIdentity,
    isPathInside,
    isUnavailablePath,
    listDirectoryNames,
    pathExists,
    readSmallTextFile,
    resolveTarget,
    UnverifiedPathError
} from '../../core/filesystem/index.ts'
import type { CleanupCandidate, RemovalCallbacks } from '../../core/types.ts'
import { compareVersions } from '../../core/versions.ts'
import type { ProcessLister } from '../../windows/processes.ts'

/** Scoop version directories and the `persist` entries of its manifests use plain dotted numbers. */
const plainVersion = /^\d+(?:\.\d+)*$/

interface ScoopRelease {
    readonly name: string
    /** The release channel Scoop recorded at install time: a bucket, or the manifest URL for URL and path installs. */
    readonly channel: string | null
    readonly held: boolean
    /** Declared `persist` entries by lowercase source path, mapped to their path under `persist\<app>`. */
    readonly persist: ReadonlyMap<string, string>
}

interface ScoopApp {
    readonly name: string
    readonly appDir: string
    readonly persistRoot: string
    readonly selected: ScoopRelease
}

interface VersionTree {
    /** Junctions and hard links into the app's shared `persist` directory. They are unlinked, never followed. */
    readonly persistLinks: readonly string[]
    readonly sizeBytes: number
    readonly fileCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string, allowedRoot: string): Promise<Record<string, unknown> | null> {
    const text = await readSmallTextFile(path, allowedRoot)
    if (text === null) return null
    try {
        const value: unknown = JSON.parse(text)
        return isRecord(value) ? value : null
    } catch {
        return null
    }
}

function relativeKey(path: string): string {
    return normalize(path)
        .replace(/[\\/]+$/, '')
        .toLowerCase()
}

function persistEntries(manifest: Record<string, unknown>): Map<string, string> {
    const entries = new Map<string, string>()
    const declared = manifest.persist
    for (const entry of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
        const [source, target] = Array.isArray(entry) ? entry : [entry]
        const destination = typeof target === 'string' && target ? target : source
        if (typeof source !== 'string' || typeof destination !== 'string' || !source || isAbsolute(source) || isAbsolute(destination)) continue
        if (normalize(source).startsWith('..') || normalize(destination).startsWith('..')) continue
        entries.set(relativeKey(source), normalize(destination))
    }
    return entries
}

function releaseChannel(install: Record<string, unknown>): string | null {
    if (typeof install.bucket === 'string' && install.bucket) return `bucket:${install.bucket}`
    if (typeof install.url === 'string' && install.url) return `url:${install.url}`
    return null
}

/** Reads a version directory's Scoop manifest and install metadata. Incomplete or inconsistent releases return null. */
async function readRelease(appDir: string, name: string): Promise<ScoopRelease | null> {
    if (!plainVersion.test(name)) return null
    const manifest = await readJson(join(appDir, name, 'manifest.json'), appDir)
    const install = await readJson(join(appDir, name, 'install.json'), appDir)
    if (!manifest || !install || manifest.version !== name) return null
    return {
        name,
        channel: releaseChannel(install),
        held: install.hold === true,
        persist: persistEntries(manifest)
    }
}

/** The app's shared persist directory. Apps without persisted data have none, and nothing can link into it. */
async function canonicalPersistRoot(root: string, name: string): Promise<string> {
    const persistRoot = join(root, 'persist', name)
    try {
        return await realpath(persistRoot)
    } catch (error) {
        if (isUnavailablePath(error)) return persistRoot
        throw error
    }
}

/** The selected release from the app's `current` junction, which must point at a verified sibling version directory. */
async function inspectApp(root: string, name: string): Promise<ScoopApp | null> {
    const appDir = join(root, 'apps', name)
    try {
        const canonicalApp = await realpath(appDir)
        const current = join(appDir, 'current')
        if (!(await lstat(current)).isSymbolicLink()) return null
        const target = await realpath(current)
        if (canonicalPathKey(dirname(target)) !== canonicalPathKey(canonicalApp)) return null
        const selected = await readRelease(appDir, basename(target))
        if (!selected) return null
        return { name, appDir, persistRoot: await canonicalPersistRoot(root, name), selected }
    } catch (error) {
        if (isUnavailablePath(error)) return null
        throw error
    }
}

function isSuperseded(app: ScoopApp, release: ScoopRelease): boolean {
    return (
        release.name !== app.selected.name &&
        !release.held &&
        release.channel !== null &&
        release.channel === app.selected.channel &&
        compareVersions(release.name, app.selected.name) < 0
    )
}

async function samePersistedFile(stats: BigIntStats, counterpart: string): Promise<boolean> {
    try {
        const other = await lstat(counterpart, { bigint: true })
        return other.isFile() && other.dev === stats.dev && other.ino === stats.ino
    } catch (error) {
        if (isUnavailablePath(error)) return false
        throw error
    }
}

/**
 * Walks a version directory. Everything must be a real file or directory, a junction into the
 * app's shared `persist` directory, or a hard link to a declared persisted file. Anything else
 * makes the version unverifiable.
 */
async function inspectVersionTree(
    directory: string,
    relativePath: string,
    app: ScoopApp,
    release: ScoopRelease,
    total: { size: number; files: number },
    links: string[]
): Promise<boolean> {
    for (const name of await readdir(directory)) {
        const path = join(directory, name)
        const entryPath = relativePath ? join(relativePath, name) : name
        const stats = await lstat(path, { bigint: true })
        if (stats.isSymbolicLink()) {
            if (!isPathInside(await realpath(path), app.persistRoot)) return false
            links.push(path)
        } else if (stats.isDirectory()) {
            if (!(await inspectVersionTree(path, entryPath, app, release, total, links))) return false
        } else if (stats.isFile() && stats.nlink === 1n) {
            total.size += Number(stats.size)
            total.files += 1
        } else if (stats.isFile()) {
            const target = release.persist.get(relativeKey(entryPath))
            if (!target || !(await samePersistedFile(stats, join(app.persistRoot, target)))) return false
            links.push(path)
        } else {
            return false
        }
    }
    return true
}

async function readVersionTree(app: ScoopApp, release: ScoopRelease): Promise<VersionTree | null> {
    const total = { size: 0, files: 0 }
    const persistLinks: string[] = []
    try {
        if (!(await inspectVersionTree(join(app.appDir, release.name), '', app, release, total, persistLinks))) return null
    } catch (error) {
        if (isUnavailablePath(error)) return null
        throw error
    }
    return { persistLinks, sizeBytes: total.size, fileCount: total.files }
}

async function inUseVersions(listProcesses: ProcessLister, directories: readonly string[]): Promise<Set<string> | null> {
    const inUse = new Set<string>()
    try {
        for (const entry of await listProcesses()) {
            const locations = [entry.path, entry.commandLine].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase())
            // A process counts as using a version when its image or command line mentions the directory.
            for (const directory of directories) {
                const key = directory.toLowerCase()
                if (locations.some((location) => location.includes(key))) inUse.add(directory)
            }
        }
        return inUse
    } catch {
        return null
    }
}

export async function detectScoopInstallations(root: string, home: string, listProcesses: ProcessLister): Promise<CleanupCandidate[]> {
    if (!isPathInside(root, home) || !(await pathExists(join(root, 'apps', 'scoop', 'current')))) return []

    const planned: { app: ScoopApp; release: ScoopRelease; tree: VersionTree }[] = []
    for (const name of await listDirectoryNames(join(root, 'apps'))) {
        if (name === 'scoop') continue
        const app = await inspectApp(root, name)
        if (!app) continue
        for (const versionName of await listDirectoryNames(app.appDir)) {
            const release = await readRelease(app.appDir, versionName)
            if (!release || !isSuperseded(app, release)) continue
            const tree = await readVersionTree(app, release)
            if (tree) planned.push({ app, release, tree })
        }
    }
    if (planned.length === 0) return []

    const candidates: { candidate: CleanupCandidate; locations: string[] }[] = []
    for (const { app, release, tree } of planned) {
        const candidate = await versionCandidate(app, release, tree)
        if (candidate?.path && candidate.canonicalPath) candidates.push({ candidate, locations: [candidate.path, candidate.canonicalPath] })
    }
    const inUse = await inUseVersions(
        listProcesses,
        candidates.flatMap(({ locations }) => locations)
    )
    if (!inUse) return []
    return candidates.filter(({ locations }) => !locations.some((location) => inUse.has(location))).map(({ candidate }) => candidate)
}

async function versionCandidate(app: ScoopApp, release: ScoopRelease, tree: VersionTree): Promise<CleanupCandidate | null> {
    const path = join(app.appDir, release.name)
    try {
        const target = await resolveTarget(path, app.appDir)
        return {
            id: `scoop:version:${app.name}:${release.name}`,
            kind: 'filesystem',
            displayName: `Scoop ${app.name} ${release.name}`,
            reason: `Superseded Scoop version. The selected ${app.name} version is ${app.selected.name}. Shared persistent data is preserved.`,
            sizeBytes: tree.sizeBytes,
            fileCount: tree.fileCount,
            modifiedAt: target.stats.mtime,
            path,
            allowedRoot: app.appDir,
            canonicalPath: target.path,
            filesystemIdentity: target.identity
        }
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return null
        throw error
    }
}

async function unlinkPersistLink(path: string): Promise<void> {
    // A junction is removed as a directory entry, never emptied: its target is the shared data.
    // A hard-linked file is unlinked as is; its read-only attribute is shared with the persisted copy.
    if ((await lstat(path)).isSymbolicLink()) await rmdir(path)
    else await unlink(path)
}

/**
 * Re-verifies a detected version at removal time, then unlinks its persisted-data links so the
 * generic removal sees only the version's own files. Throws when the selection, layout, or
 * in-use status no longer match detection.
 */
export async function prepareScoopRemoval(candidate: CleanupCandidate, root: string, listProcesses: ProcessLister, callbacks: RemovalCallbacks): Promise<void> {
    const match = /^scoop:version:([^:]+):(.+)$/.exec(candidate.id)
    if (!match?.[1] || !match[2] || !candidate.path || !candidate.canonicalPath || !candidate.allowedRoot || !candidate.filesystemIdentity) {
        throw new Error(`Missing verified path for ${candidate.displayName}.`)
    }
    const [, appName, versionName] = match
    const changed = new Error(`The Scoop installation changed after detection at ${candidate.path}.`)

    const app = await inspectApp(root, appName)
    if (!app || canonicalPathKey(join(app.appDir)) !== canonicalPathKey(candidate.allowedRoot) || basename(candidate.path) !== versionName) throw changed
    const release = await readRelease(app.appDir, versionName)
    if (!release || !isSuperseded(app, release)) throw changed
    const target = await resolveTarget(candidate.path, app.appDir)
    if (!hasIdentity(target, candidate.filesystemIdentity)) throw changed
    const tree = await readVersionTree(app, release)
    if (!tree) throw changed

    const inUse = await inUseVersions(listProcesses, [candidate.path, target.path])
    if (!inUse || inUse.size > 0) throw new Error(`${candidate.displayName} is in use or could not be verified as inactive.`)

    for (const path of tree.persistLinks) {
        await unlinkPersistLink(path)
        await callbacks.onRemoved({ kind: 'link', path, sizeBytes: 0, modifiedAt: null })
    }
}
