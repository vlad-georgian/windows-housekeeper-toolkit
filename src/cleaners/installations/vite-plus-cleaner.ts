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
 * this only while holding the installation lock, because a rollback rewrites both.
 */
async function inspectStore(home: string): Promise<ReleaseStore | null> {
    try {
        const canonicalHome = await realpath(home)
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
        try {
            await lstat(fallback)
            const recorded = (await readSmallTextFile(fallback, canonicalHome))?.trim()
            if (!recorded || !releaseName.test(recorded)) return null
            retained.add(nameKey(recorded))
        } catch (error) {
            if (!isUnavailablePath(error)) throw error
        }
        return { home: canonicalHome, active, retained }
    } catch (error) {
        if (isUnavailablePath(error)) return null
        throw error
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

    /** Runs `action` while holding Vite+'s installation lock, or returns `null` if it cannot be taken. */
    private async underLock<T>(home: string, action: () => Promise<T>): Promise<T | null> {
        let canonicalHome: string
        try {
            canonicalHome = await realpath(home)
        } catch (error) {
            if (isUnavailablePath(error)) return null
            throw error
        }
        const release = await this.acquireLock(join(canonicalHome, '.install.lock'))
        if (!release) return null
        try {
            return await action()
        } finally {
            release()
        }
    }

    /** Whether a running process is, or could be running from, the release. Unverifiable counts as in use. */
    private async inUse(release: string): Promise<boolean> {
        const paths = await runningProcessPaths(this.listProcesses, vitePlusProcess)
        const commandLines = await runtimeCommandLines(this.listProcesses, scriptRuntime)
        return paths === null || commandLines === null || isPathInUse(release, paths) || isPathReferenced(release, commandLines)
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const home = await dataDirectory(this.paths, this.environment)
        if (!home) return []
        return (await this.underLock(home, () => this.detectLocked(home))) ?? []
    }

    private async detectLocked(home: string): Promise<CleanupCandidate[]> {
        const store = await inspectStore(home)
        if (!store) return []

        const candidates: CleanupCandidate[] = []
        for (const name of await listDirectoryNames(store.home)) {
            if (!(await canRemoveRelease(store, name)) || (await this.inUse(join(store.home, name)))) continue
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
        const result = await this.underLock(home, async () => {
            // Read the selection and fallback only now that a rollback cannot change them.
            const store = await inspectStore(home)
            if (!store || candidate.id !== `vite-plus:release:${name}` || !(await canRemoveRelease(store, name))) {
                throw new Error(`The Vite+ release selection changed after detection at ${home}.`)
            }
            if (await this.inUse(path)) throw new Error(`Could not verify that ${candidate.displayName} is inactive.`)
            return super.remove(candidate, callbacks)
        })
        if (!result) throw new Error(`Could not take the Vite+ installation lock at ${home}. The installer may be running.`)
        return result
    }
}
