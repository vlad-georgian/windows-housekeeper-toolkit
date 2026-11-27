import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { canonicalPathKey, createFilesystemCandidate, isUnavailablePath, listDirectoryNames, readSmallTextFile } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { compareVersions } from '../../core/versions.ts'
import { listWindowsProcesses } from '../../windows/processes.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import type { Environment } from '../helpers.ts'
import type { ProcessLister } from './codex-installations.ts'
import { isPathInUse, runningProcessPaths } from './running-paths.ts'

const releaseName = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

interface ReleaseStore {
    readonly home: string
    readonly active: string
    readonly retained: ReadonlySet<string>
}

async function verifyRelease(home: string, name: string): Promise<boolean> {
    if (!releaseName.test(name)) return false
    const manifest = await readSmallTextFile(join(home, name, 'package.json'), home)
    if (manifest === null) return false
    try {
        const parsed: unknown = JSON.parse(manifest)
        return typeof parsed === 'object' && parsed !== null && 'version' in parsed && parsed.version === name
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
    return releaseName.test(name) && !store.retained.has(name) && compareVersions(name, store.active) < 0 && (await verifyRelease(store.home, name))
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
        private readonly listProcesses: ProcessLister = listWindowsProcesses
    ) {
        super()
    }

    private home(): string {
        const override = this.environment.VP_HOME
        return override && isAbsolute(override) ? override : join(this.paths.home, '.vite-plus')
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const home = this.home()
        const store = await inspectStore(home)
        if (!store) return []
        const processes = await runningProcessPaths(this.listProcesses)
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
                type: 'directory'
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
        const processes = await runningProcessPaths(this.listProcesses)
        if (!store || processes === null || candidate.id !== `vite-plus:release:${name}` || !(await canRemoveRelease(store, name))) {
            throw new Error(`The Vite+ release selection changed after detection at ${dirname(path)}.`)
        }
        if (isPathInUse(path, processes)) throw new Error(`${candidate.displayName} is in use.`)
        return super.remove(candidate, callbacks)
    }
}
