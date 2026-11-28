import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { canonicalPathKey, createFilesystemCandidate, isUnavailablePath, listDirectoryNames, readSmallTextFile } from '../../core/filesystem/index.ts'
import { hasErrorCode } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { compareSemver } from '../../core/versions.ts'
import { listWindowsProcesses, type ProcessLister } from '../../windows/processes.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import type { Environment } from '../helpers.ts'
import { isPathInUse, isPathReferenced, runningProcessPaths, runtimeCommandLines } from './running-paths.ts'
import { acquireInstallLock, type InstallLockAcquirer } from './vite-plus-install-lock.ts'

// A release directory is named by its version. `vp upgrade --force` adds a `+force.<pid>.<nanos>`
// suffix so it can reinstall the active version beside the running binary.
const releaseName = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+force\.\d+\.\d+)?$/
// Executables that run from, or write into, a release. An unreadable one blocks removal.
const vitePlusProcess = /^(?:vp[rx]?|node|pnpm|oxlint|oxfmt|tsgolint)(?:\.exe)?$/i
// Vite+ starts an external Node with a release script as its argument, so the executable path alone does not show use.
const scriptRuntime = /^(?:node|bun)(?:\.exe)?$/i
// Vite+ serializes upgrades and rollbacks with `.install.lock` from 1.7.0. Earlier releases roll back without any lock.
const firstLockedRelease = '1.7.0'

const baseVersion = (name: string): string | null => releaseName.exec(name)?.[1] ?? null
// Windows folds case, so names that differ only in case are the same release.
const nameKey = (name: string): string => name.toLowerCase()

interface ReleaseStore {
    readonly home: string
    readonly active: string
    readonly retained: ReadonlySet<string>
}

/**
 * Vite+ keeps releases in one directory. Since 0.3.0 that is the split data directory, unless
 * `VP_HOME` pins one root or a `~\.vite-plus` install already exists and is reused.
 *
 * Returns `null` when `~\.vite-plus` exists but cannot be read as a directory with certainty.
 * Windows reports a missing `current` under an unreadable parent in the same way as for a plain
 * split install, so a damaged legacy directory must not fall through to the split layout.
 */
async function dataDirectory(paths: SystemPaths, environment: Environment): Promise<string | null> {
    const pinned = environment.VP_HOME
    if (pinned && isAbsolute(pinned)) return pinned

    const legacy = join(paths.home, '.vite-plus')
    let legacyStats
    try {
        legacyStats = await lstat(legacy)
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) return null
    }
    if (legacyStats) {
        // A relocated install is a link to a directory. A file or an unresolvable link is damage.
        const isDirectory = await stat(legacy).then(
            (entry) => entry.isDirectory(),
            () => false
        )
        if (!isDirectory) return null
        try {
            await lstat(join(legacy, 'current'))
            return legacy
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) return null
        }
    }

    // The directory group is only honored when set completely, as the Vite+ installer requires.
    const group = [environment.VP_BIN_DIR, environment.VP_DATA_DIR, environment.VP_CACHE_DIR]
    const [, data] = group
    return data && group.every((value) => value && isAbsolute(value)) ? data : join(paths.localAppData, 'vite-plus', 'data')
}

/** Whether the release directory holds the wrapper project the Vite+ installer writes for `version`. */
async function verifyRelease(home: string, name: string): Promise<boolean> {
    const version = baseVersion(name)
    if (!version) return false
    const manifest = await readSmallTextFile(join(home, name, 'package.json'), home)
    if (manifest === null) return false
    try {
        const parsed: unknown = JSON.parse(manifest)
        if (typeof parsed !== 'object' || parsed === null) return false
        const dependencies: unknown = 'dependencies' in parsed ? parsed.dependencies : null
        return (
            'name' in parsed &&
            parsed.name === 'vp-global' &&
            'version' in parsed &&
            parsed.version === version &&
            typeof dependencies === 'object' &&
            dependencies !== null &&
            'vite-plus' in dependencies &&
            dependencies['vite-plus'] === version
        )
    } catch {
        return false
    }
}

/**
 * Reads Vite+'s selected release (`current`) and the fallback recorded for `vp upgrade --rollback`
 * (`.previous-version`). Returns `null` unless both can be verified, so nothing is offered. Call
 * this only while holding the installation lock, because a rollback rewrites both. `canonicalHome`
 * is the store resolved once, never an alias that could be retargeted.
 */
async function inspectStore(canonicalHome: string): Promise<ReleaseStore | null> {
    try {
        const current = join(canonicalHome, 'current')
        if (!(await lstat(current)).isSymbolicLink()) return null
        const activePath = await realpath(current)
        const active = basename(activePath)
        if (canonicalPathKey(dirname(activePath)) !== canonicalPathKey(canonicalHome) || !(await verifyRelease(canonicalHome, active))) {
            return null
        }
        // Without a lock-aware updater a rollback can swap `current` after any check we make.
        const locked = compareSemver(baseVersion(active) ?? '', firstLockedRelease)
        if (locked === null || locked < 0) return null

        const retained = new Set([nameKey(active)])
        const fallback = join(canonicalHome, '.previous-version')
        // Only a confirmed absence means no fallback is recorded. Any other failure could hide one.
        const recorded = await lstat(fallback).then(
            () => 'present' as const,
            (error: unknown) => (hasErrorCode(error, 'ENOENT') ? ('absent' as const) : ('unreadable' as const))
        )
        if (recorded === 'unreadable') return null
        if (recorded === 'present') {
            const marker = (await readSmallTextFile(fallback, canonicalHome))?.trim()
            if (!marker || !releaseName.test(marker)) return null
            retained.add(nameKey(marker))
            // Rollback uses whatever the marker names, so a link there protects the release it really reaches.
            const target = await resolveFallbackTarget(canonicalHome, marker)
            if (target === null) return null
            if (target) retained.add(nameKey(target))
        }
        return { home: canonicalHome, active, retained }
    } catch (error) {
        if (isUnavailablePath(error)) return null
        throw error
    }
}

/**
 * The release directory that the fallback marker really names. Returns `undefined` when the named
 * directory is confirmed missing, the real directory's name when it exists directly in the store,
 * and `null` when it exists but cannot be resolved there, which leaves the fallback ambiguous.
 */
async function resolveFallbackTarget(canonicalHome: string, marker: string): Promise<string | undefined | null> {
    const named = join(canonicalHome, marker)
    try {
        await lstat(named)
    } catch (error) {
        return hasErrorCode(error, 'ENOENT') ? undefined : null
    }
    try {
        const target = await realpath(named)
        return canonicalPathKey(dirname(target)) === canonicalPathKey(canonicalHome) && baseVersion(basename(target)) !== null ? basename(target) : null
    } catch {
        return null
    }
}

async function canRemoveRelease(store: ReleaseStore, name: string): Promise<boolean> {
    const version = baseVersion(name)
    const active = baseVersion(store.active)
    if (version === null || active === null || store.retained.has(nameKey(name))) return false
    const order = compareSemver(version, active)
    return order !== null && order < 0 && (await verifyRelease(store.home, name))
}

export class VitePlusInstallationCleaner extends BaseCleaner {
    readonly id = 'vite-plus-releases'
    readonly appId = 'vite-plus'
    readonly category = 'old-installations'
    readonly label = 'Vite+'
    readonly description = 'Superseded Vite+ releases'
    // Release removal checks the running Vite+ binaries itself.
    readonly manualRunningAppCheck = false

    constructor(
        private readonly paths: SystemPaths,
        private readonly environment: Environment = process.env,
        private readonly listProcesses: ProcessLister = listWindowsProcesses,
        private readonly acquireLock: InstallLockAcquirer = acquireInstallLock
    ) {
        super()
    }

    /**
     * Resolves the store once, takes Vite+'s installation lock on that exact directory, and runs
     * `action` with the canonical store. The action must use only that path, never the alias, so a
     * link retargeted after resolution cannot send it to another store. Returns `null` if the
     * store cannot be resolved or the lock cannot be taken.
     */
    private async underLock<T>(home: string, action: (canonicalHome: string) => Promise<T>): Promise<T | null> {
        let canonicalHome: string
        try {
            canonicalHome = await realpath(home)
        } catch (error) {
            if (isUnavailablePath(error)) return null
            throw error
        }
        const release = await this.acquireLock(canonicalHome)
        if (!release) return null
        try {
            return await action(canonicalHome)
        } finally {
            release()
        }
    }

    /**
     * Whether a process names the store's `current` link, as itself or as its script. A runtime
     * started before an update keeps loading files lazily from the release it started in, yet names
     * only the link, so the release it uses cannot be told. The whole store is then ambiguous.
     */
    private async storeAmbiguous(canonicalHome: string, logicalHome: string | null, snapshot: ProcessLister): Promise<boolean> {
        const paths = await runningProcessPaths(snapshot, vitePlusProcess)
        const commandLines = await runtimeCommandLines(snapshot, scriptRuntime)
        if (paths === null || commandLines === null) return true
        const links = [...new Set([join(canonicalHome, 'current'), ...(logicalHome ? [join(logicalHome, 'current')] : [])])]
        return links.some((link) => isPathInUse(link, paths) || isPathReferenced(link, commandLines))
    }

    /** Whether a running process is, or could be running from, the release. Unverifiable counts as in use. */
    private async inUse(releases: readonly string[], snapshot: ProcessLister): Promise<boolean> {
        const paths = await runningProcessPaths(snapshot, vitePlusProcess)
        const commandLines = await runtimeCommandLines(snapshot, scriptRuntime)
        if (paths === null || commandLines === null) return true
        // A command line names the release however the caller spelled it, such as through a relocated ~.vite-plus link.
        return releases.some((release) => isPathInUse(release, paths) || isPathReferenced(release, commandLines))
    }

    /** One process inventory for a whole verification, so every release is judged against the same snapshot. */
    private async processSnapshot(): Promise<ProcessLister> {
        try {
            const processes = await this.listProcesses()
            return async () => processes
        } catch (error) {
            return () => Promise.reject(error)
        }
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const home = await dataDirectory(this.paths, this.environment)
        if (!home) return []
        return (await this.underLock(home, (canonicalHome) => this.detectLocked(canonicalHome, home))) ?? []
    }

    /** Every way a process can name a release: its physical path and the same name under the logical home. */
    private spellings(canonicalHome: string, name: string, logicalHome: string | null): string[] {
        return [...new Set([join(canonicalHome, name), ...(logicalHome ? [join(logicalHome, name)] : [])])]
    }

    private async detectLocked(home: string, logicalHome: string): Promise<CleanupCandidate[]> {
        const store = await inspectStore(home)
        if (!store) return []
        const snapshot = await this.processSnapshot()
        if (await this.storeAmbiguous(store.home, logicalHome, snapshot)) return []

        const candidates: CleanupCandidate[] = []
        for (const name of await listDirectoryNames(store.home)) {
            if (!(await canRemoveRelease(store, name)) || (await this.inUse(this.spellings(store.home, name, logicalHome), snapshot))) continue
            const candidate = await createFilesystemCandidate({
                id: `vite-plus:release:${name}`,
                path: join(home, name),
                allowedRoot: home,
                displayName: `Vite+ ${name}`,
                reason: `Superseded release. The active release ${store.active}${store.retained.size > 1 ? ' and the recorded fallback are' : ' is'} preserved.`,
                type: 'directory',
                // A release is a pnpm install: junctions into its virtual store and files hardlinked
                // from the shared content store. They are unlinked through verified handles, never followed.
                unlinkTreeLinks: true
            })
            if (candidate) candidates.push(candidate)
        }
        return candidates
    }

    override async remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        const path = candidate.canonicalPath
        if (!path) throw new Error(`Missing verified path for ${candidate.displayName}.`)
        const name = basename(path)
        const home = dirname(path)
        const result = await this.underLock(home, async (canonicalHome) => {
            // The candidate was detected in this exact store. A store that resolves elsewhere now is not it.
            if (canonicalPathKey(canonicalHome) !== canonicalPathKey(home)) throw new Error(`The Vite+ store at ${home} now resolves elsewhere.`)
            // Read the selection and fallback only now that a rollback cannot change them.
            const store = await inspectStore(canonicalHome)
            if (!store || candidate.id !== `vite-plus:release:${name}` || !(await canRemoveRelease(store, name))) {
                throw new Error(`The Vite+ release selection changed after detection at ${home}.`)
            }
            const logicalHome = await dataDirectory(this.paths, this.environment)
            const snapshot = await this.processSnapshot()
            if ((await this.storeAmbiguous(canonicalHome, logicalHome, snapshot)) || (await this.inUse(this.spellings(canonicalHome, name, logicalHome), snapshot))) {
                throw new Error(`Could not verify that ${candidate.displayName} is inactive.`)
            }
            return super.remove(candidate, callbacks)
        })
        if (!result) throw new Error(`Could not take the Vite+ installation lock at ${home}. The installer may be running.`)
        return result
    }
}
