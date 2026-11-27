import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { canonicalPathKey, isUnavailablePath, pathExists, readSmallTextFile } from '../core/filesystem/index.ts'
import { compareVersions } from '../core/versions.ts'

export const storeNames = ['standalone', 'app-server-daemon'] as const
const releaseName = /^(\d+\.\d+\.\d+)-((?:x86_64|aarch64)-pc-windows-msvc)$/i

interface ReleaseStore {
    readonly releases: string
    readonly active: string
    readonly retained: ReadonlySet<string>
}

function isManifest(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readManifest(path: string, allowedRoot: string): Promise<Record<string, unknown> | null> {
    const content = await readSmallTextFile(path, allowedRoot)
    if (content === null) return null
    try {
        const manifest: unknown = JSON.parse(content)
        return isManifest(manifest) ? manifest : null
    } catch {
        return null
    }
}

async function verifyRelease(root: string, name: string): Promise<boolean> {
    const release = releaseName.exec(name)
    if (!release) return false
    const path = join(root, name)
    const manifest = await readManifest(join(path, 'codex-package.json'), root)
    if (
        !manifest ||
        manifest.layoutVersion !== 1 ||
        manifest.version !== release[1] ||
        manifest.target !== release[2] ||
        (manifest.variant !== 'codex' && manifest.variant !== 'codex-app-server') ||
        manifest.entrypoint !== 'bin/codex.exe'
    ) {
        return false
    }
    const binary = join(path, 'bin', 'codex.exe')
    const stats = await lstat(binary)
    return stats.isFile() && canonicalPathKey(await realpath(binary)) === canonicalPathKey(binary)
}

export async function inspectReleaseStore(codexHome: string, storeName: string): Promise<ReleaseStore | null> {
    try {
        const home = await realpath(codexHome)
        const store = join(home, 'packages', storeName)
        const releases = join(store, 'releases')
        if (canonicalPathKey(await realpath(releases)) !== canonicalPathKey(releases)) return null

        const current = join(store, 'current')
        if (!(await lstat(current)).isSymbolicLink()) return null
        if (await pathExists(join(store, '.migration-current'))) return null

        const activePath = await realpath(current)
        const active = basename(activePath)
        if (canonicalPathKey(dirname(activePath)) !== canonicalPathKey(releases) || !(await verifyRelease(releases, active))) {
            return null
        }

        const updateMarker = join(store, 'auto-update-version')
        if ((await pathExists(updateMarker)) && (await readSmallTextFile(updateMarker, store))?.trim() !== active) {
            return null
        }

        const retained = new Set([active])
        const history = await readSmallTextFile(join(store, 'selection-history'), store)
        if (history) {
            const [selected, previous] = history.trim().split(/\r?\n/)
            if (selected === active && previous && releaseName.test(previous)) retained.add(previous)
        }
        return { releases, active, retained }
    } catch (error) {
        if (isUnavailablePath(error)) return null
        throw error
    }
}

export async function canRemoveRelease(store: ReleaseStore, name: string): Promise<boolean> {
    try {
        return (
            releaseName.test(name) &&
            !store.retained.has(name) &&
            compareVersions(name.split('-')[0] ?? '', store.active.split('-')[0] ?? '') < 0 &&
            (await verifyRelease(store.releases, name))
        )
    } catch (error) {
        if (isUnavailablePath(error)) return false
        throw error
    }
}
