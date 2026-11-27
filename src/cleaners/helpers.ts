import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'

import { canonicalPathKey, createFilesystemCandidate, isPathInside, isUnavailablePath, listDirectoryNames, readSmallTextFile } from '../core/filesystem/index.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate } from '../core/types.ts'
import { compareVersions } from '../core/versions.ts'
import { listWindowsProcesses } from '../windows/processes.ts'

export async function detectUpdaterDirectory(options: {
    readonly appId: string
    readonly updaterRoot: string
    readonly allowedRoot: string
    readonly label: string
}): Promise<CleanupCandidate[]> {
    const candidates: CleanupCandidate[] = []
    for (const subdirectory of ['', 'pending']) {
        const directory = join(options.updaterRoot, subdirectory)
        for (const name of await listDirectoryNames(directory)) {
            if (!/\.(?:exe|msi|exe\.blockmap|msi\.blockmap)$/i.test(name)) continue
            const candidate = await createFilesystemCandidate({
                id: `${options.appId}:updater:${subdirectory || 'cache'}:${name}`,
                path: join(directory, name),
                allowedRoot: options.allowedRoot,
                displayName: `${options.label} downloaded ${name}`,
                reason: 'Redownloadable installer payload in the application updater cache',
                type: 'file'
            })
            if (candidate) candidates.push(candidate)
        }
    }
    return candidates
}

export async function detectNamedCaches(
    appId: string,
    label: string,
    profile: string,
    cacheDirectories: readonly (readonly [path: string, reason: string])[]
): Promise<CleanupCandidate[]> {
    const candidates: CleanupCandidate[] = []
    for (const [name, reason] of cacheDirectories) {
        const candidate = await createFilesystemCandidate({
            id: `${appId}:cache:${name}`,
            path: join(profile, name),
            allowedRoot: profile,
            displayName: `${label} ${name}`,
            reason,
            type: 'directory'
        })
        if (candidate && (candidate.fileCount ?? 0) > 0) candidates.push(candidate)
    }
    return candidates
}

interface SquirrelInstallationOptions {
    readonly appId: string
    readonly appRoot: string
    readonly allowedRoot: string
    readonly label: string
}

async function inspectSquirrelInstallation(appRoot: string, allowedRoot: string): Promise<{ current: string; removableVersions: string[] } | null> {
    if (!isPathInside(appRoot, allowedRoot)) return null
    try {
        const canonicalParent = await realpath(allowedRoot)
        const updater = join(canonicalParent, relative(allowedRoot, appRoot), 'Update.exe')
        if (!(await lstat(updater)).isFile() || canonicalPathKey(await realpath(updater)) !== canonicalPathKey(updater)) {
            return null
        }
    } catch (error) {
        if (isUnavailablePath(error)) return null
        throw error
    }

    const releaseIndex = await readSmallTextFile(join(appRoot, 'packages', 'RELEASES'), allowedRoot)
    if (!releaseIndex) return null
    const current = releaseIndex
        .split(/\r?\n/)
        .flatMap((line) => {
            const match = /^[\da-f]{40}\s+[^\\/\s]+?[-.](\d+(?:\.\d+){2,3})-full\.nupkg\s+\d+\s*$/i.exec(line)
            return match?.[1] ? [match[1]] : []
        })
        .toSorted((left, right) => compareVersions(right, left))[0]
    if (!current) return null

    const versions = (await listDirectoryNames(appRoot))
        .filter((name) => /^app-\d+(?:\.\d+){2,3}$/i.test(name))
        .toSorted((left, right) => compareVersions(right.replace(/^app-/i, ''), left.replace(/^app-/i, '')))
    if (versions[0]?.toLowerCase() !== `app-${current}`) return null
    // Squirrel's own cleanup retains the current and immediately previous versions.
    return { current, removableVersions: versions.slice(2) }
}

export async function detectSquirrelInstallation(options: SquirrelInstallationOptions): Promise<CleanupCandidate[]> {
    const installation = await inspectSquirrelInstallation(options.appRoot, options.allowedRoot)
    if (!installation) return []

    const candidates: CleanupCandidate[] = []
    for (const oldVersion of installation.removableVersions) {
        const candidate = await createFilesystemCandidate({
            id: `${options.appId}:old-version:${oldVersion}`,
            path: join(options.appRoot, oldVersion),
            allowedRoot: options.appRoot,
            displayName: `${options.label} ${oldVersion.replace(/^app-/i, '')}`,
            reason: `Older Squirrel release. The current ${installation.current} and previous releases are retained.`,
            type: 'directory'
        })
        if (candidate) candidates.push(candidate)
    }

    return candidates
}

export async function verifySquirrelVersionBeforeRemoval(candidate: CleanupCandidate): Promise<void> {
    if (!candidate.path || !candidate.allowedRoot || !candidate.canonicalPath) {
        throw new Error(`Missing verified path for ${candidate.displayName}.`)
    }
    const appRoot = candidate.allowedRoot
    const installation = await inspectSquirrelInstallation(appRoot, dirname(appRoot))
    if (!installation?.removableVersions.includes(basename(candidate.path))) {
        throw new Error(`The Squirrel installation changed after detection at ${appRoot}.`)
    }
    for (const entry of await listWindowsProcesses()) {
        if (!entry.path) continue
        if (isPathInside(entry.path, candidate.canonicalPath)) {
            throw new Error(`${candidate.displayName} is in use.`)
        }
    }
}

export function localPath(paths: SystemPaths, ...parts: string[]): string {
    return join(paths.localAppData, ...parts)
}
