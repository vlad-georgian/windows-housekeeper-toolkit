import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { canonicalPathKey, createFilesystemCandidate, isUnavailablePath, listDirectoryNames, readSmallTextFile } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { compareVersions } from '../../core/versions.ts'
import { listWindowsProcesses } from '../../windows/processes.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import type { Environment } from '../helpers.ts'
import { isPathInUse, type ProcessLister, runningProcessPaths } from './running-paths.ts'
import { isInstallLockHeld } from './vite-plus-install-lock.ts'

// A release directory is named by its version. `vp upgrade --force` adds a `+force.<pid>.<nanos>`
// suffix so it can reinstall the active version beside the running binary.
const releaseName = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+force\.\d+\.\d+)?$/
// Executables that run from, or write into, a release. An unreadable one blocks removal.
const vitePlusProcess = /^(?:vp[rx]?|node|pnpm|oxlint|oxfmt|tsgolint)(?:\.exe)?$/i

const baseVersion = (name: string): string | null => releaseName.exec(name)?.[1] ?? null

type InstallLockProbe = (lockPath: string) => Promise<boolean>

interface ReleaseStore {
    readonly home: string
    readonly active: string
    readonly retained: ReadonlySet<string>
}

/**
 * Vite+ keeps releases in one directory. Since 0.3.0 that is the split data directory, unless
 * `VP_HOME` pins one root or a `~\.vite-plus` install already exists and is reused.
 */
async function dataDirectory(paths: SystemPaths, environment: Environment): Promise<string> {
    const pinned = environment.VP_HOME
    if (pinned && isAbsolute(pinned)) return pinned

    const legacy = join(paths.home, '.vite-plus')
    try {
        await lstat(join(legacy, 'current'))
        return legacy
    } catch (error) {
        if (!isUnavailablePath(error)) throw error
    }

    // The directory group is only honored when set completely, as the Vite+ installer requires.
    const group = [environment.VP_BIN_DIR, environment.VP_DATA_DIR, environment.VP_CACHE_DIR]
    const [, data] = group
    return data && group.every((value) => value && isAbsolute(value)) ? data : join(paths.localAppData, 'vite-plus', 'data')
}

async function verifyRelease(home: string, name: string): Promise<boolean> {
    const version = baseVersion(name)
    if (!version) return false
    const manifest = await readSmallTextFile(join(home, name, 'package.json'), home)
    if (manifest === null) return false
    try {
        const parsed: unknown = JSON.parse(manifest)
        return typeof parsed === 'object' && parsed !== null && 'version' in parsed && parsed.version === version
    } catch {
        return false
    }
}

/**
 * Reads Vite+'s selected release (`current`) and the fallback recorded for `vp upgrade --rollback`
 * (`.previous-version`). Returns `null` unless both can be verified, so nothing is offered.
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

        const retained = new Set([active])
        const fallback = join(canonicalHome, '.previous-version')
        try {
            await lstat(fallback)
            const recorded = (await readSmallTextFile(fallback, canonicalHome))?.trim()
            if (!recorded || !releaseName.test(recorded)) return null
            retained.add(recorded)
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
    return version !== null && active !== null && !store.retained.has(name) && compareVersions(version, active) < 0 && (await verifyRelease(store.home, name))
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
        private readonly isInstallLocked: InstallLockProbe = isInstallLockHeld
    ) {
        super()
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const home = await dataDirectory(this.paths, this.environment)
        const store = await inspectStore(home)
        if (!store || (await this.isInstallLocked(join(store.home, '.install.lock')))) return []
        const processes = await runningProcessPaths(this.listProcesses, vitePlusProcess)
        if (processes === null) return []

        const candidates: CleanupCandidate[] = []
        for (const name of await listDirectoryNames(store.home)) {
            if (!(await canRemoveRelease(store, name)) || isPathInUse(join(store.home, name), processes)) continue
            const candidate = await createFilesystemCandidate({
                id: `vite-plus:release:${name}`,
                path: join(home, name),
                allowedRoot: home,
                displayName: `Vite+ ${name}`,
                reason: `Superseded release. The active release ${store.active}${store.retained.size > 1 ? ' and the recorded fallback are' : ' is'} preserved.`,
                type: 'directory',
                // A release is a pnpm install: junctions into its virtual store and files hardlinked
                // from the shared content store. They are unlinked, never followed.
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
        const store = await inspectStore(dirname(path))
        if (!store || candidate.id !== `vite-plus:release:${name}` || !(await canRemoveRelease(store, name))) {
            throw new Error(`The Vite+ release selection changed after detection at ${dirname(path)}.`)
        }
        // Vite+ holds this lock while it swaps `current` or `.previous-version`, for example during a rollback.
        if (await this.isInstallLocked(join(store.home, '.install.lock'))) {
            throw new Error(`The Vite+ installer is running at ${store.home}.`)
        }
        const processes = await runningProcessPaths(this.listProcesses, vitePlusProcess)
        if (processes === null || isPathInUse(path, processes)) {
            throw new Error(`Could not verify that ${candidate.displayName} is inactive.`)
        }
        return super.remove(candidate, callbacks)
    }
}
