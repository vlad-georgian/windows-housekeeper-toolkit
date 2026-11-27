import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { canonicalPathKey, createFilesystemCandidate, isPathInside, isUnavailablePath, listDirectoryNames } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalResult } from '../../core/types.ts'
import { listWindowsProcesses, type WindowsProcess } from '../../windows/processes.ts'

export type ProcessLister = () => Promise<readonly WindowsProcess[]>
import { scoopRoot } from '../helpers.ts'
import { canRemoveRelease, inspectReleaseStore, readManifest, storeNames } from './codex-release-store.ts'

const npmRemnant = /^(?:\.codex-[\w-]+|codex-(?:old|backup|staging)-[\w-]+)$/i
const packageProcess = /^(?:codex(?:-code-mode-host|-exec-server|-command-runner|-windows-sandbox-setup)?|rg)(?:\.exe)?$/i

async function runningPackagePaths(listProcesses: ProcessLister): Promise<string[] | null> {
    try {
        const paths = new Set<string>()
        for (const entry of await listProcesses()) {
            if (!packageProcess.test(entry.name)) continue
            if (!entry.path || !isAbsolute(entry.path)) return null
            paths.add(entry.path)
            try {
                paths.add(await realpath(entry.path))
            } catch (error) {
                if (!isUnavailablePath(error)) throw error
            }
        }
        return [...paths]
    } catch {
        return null
    }
}

function releaseIsInUse(path: string, processPaths: readonly string[]): boolean {
    return processPaths.some((processPath) => isPathInside(processPath, path))
}

async function codexNpmPackage(path: string, root: string): Promise<boolean> {
    const manifest = await readManifest(join(path, 'package.json'), root)
    return manifest?.name === '@openai/codex' && typeof manifest.version === 'string'
}

function npmRoots(paths: SystemPaths): string[] {
    return [join(paths.roamingAppData, 'npm', 'node_modules', '@openai'), join(scoopRoot(paths), 'apps', 'nodejs', 'current', 'bin', 'node_modules', '@openai')]
}

export async function detectCodexInstallations(codexHome: string, paths: SystemPaths, listProcesses: ProcessLister = listWindowsProcesses): Promise<CleanupCandidate[]> {
    const processes = await runningPackagePaths(listProcesses)
    if (processes === null) return []

    const candidates: CleanupCandidate[] = []
    for (const storeName of storeNames) {
        const store = await inspectReleaseStore(codexHome, storeName)
        if (!store) continue
        const logicalRoot = join(codexHome, 'packages', storeName, 'releases')
        for (const name of await listDirectoryNames(store.releases)) {
            if (releaseIsInUse(join(store.releases, name), processes) || !(await canRemoveRelease(store, name))) {
                continue
            }
            const candidate = await createFilesystemCandidate({
                id: `codex:release:${storeName}:${name}`,
                path: join(logicalRoot, name),
                allowedRoot: logicalRoot,
                displayName: `Codex ${storeName} ${name}`,
                reason: `Superseded package release. The selected ${storeName} release is ${store.active}.`,
                type: 'directory'
            })
            if (candidate) candidates.push(candidate)
        }
    }

    for (const root of npmRoots(paths)) {
        if (!(await codexNpmPackage(join(root, 'codex'), root))) continue
        for (const name of await listDirectoryNames(root)) {
            if (!npmRemnant.test(name) || !(await codexNpmPackage(join(root, name), root))) continue
            const candidate = await createFilesystemCandidate({
                id: `codex:npm:${name}`,
                path: join(root, name),
                allowedRoot: root,
                displayName: `Codex npm update remnant ${name}`,
                reason: 'Interrupted npm update residue alongside the verified @openai/codex installation',
                type: 'directory'
            })
            if (candidate?.canonicalPath && !releaseIsInUse(candidate.canonicalPath, processes)) {
                candidates.push(candidate)
            }
        }
    }
    return candidates
}

export async function removeCodexInstallation(
    candidate: CleanupCandidate,
    codexHome: string,
    remove: () => Promise<RemovalResult>,
    listProcesses: ProcessLister = listWindowsProcesses
): Promise<RemovalResult> {
    const path = candidate.canonicalPath
    if (!path) throw new Error(`Missing verified path for ${candidate.displayName}.`)
    const name = basename(path)
    const processes = await runningPackagePaths(listProcesses)
    if (processes === null || releaseIsInUse(path, processes)) {
        throw new Error(`Could not verify that ${candidate.displayName} is inactive.`)
    }

    if (candidate.id.startsWith('codex:npm:')) {
        const root = dirname(path)
        if (!npmRemnant.test(name) || !(await codexNpmPackage(join(root, 'codex'), root)) || !(await codexNpmPackage(path, root))) {
            throw new Error(`The npm installation changed after detection at ${root}.`)
        }
        return remove()
    }

    const storeName = storeNames.find((value) => candidate.id === `codex:release:${value}:${name}`)
    if (!storeName) throw new Error(`Unexpected Codex release candidate ${candidate.id}.`)
    const root = dirname(dirname(path))
    // The Windows installer opens install.lock with FileShare.None. Keep a read handle
    // open across selection verification and deletion so it cannot select this release.
    const lockPath = join(root, 'install.lock')
    const lockStats = await lstat(lockPath)
    if (!lockStats.isFile() || canonicalPathKey(await realpath(lockPath)) !== canonicalPathKey(lockPath)) {
        throw new Error(`Could not verify the Codex installation lock at ${lockPath}.`)
    }
    const lock = await open(lockPath, 'r')
    try {
        const store = await inspectReleaseStore(codexHome, storeName)
        if (!store || canonicalPathKey(dirname(path)) !== canonicalPathKey(store.releases) || !(await canRemoveRelease(store, name))) {
            throw new Error(`The Codex ${storeName} release selection changed after detection.`)
        }
        return await remove()
    } finally {
        await lock.close()
    }
}
