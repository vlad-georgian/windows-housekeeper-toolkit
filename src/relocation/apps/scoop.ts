import { readdirSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { hasErrorCode, isPathInside, isUnavailablePath } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { type ConfiguredPath, directEntry, environmentValue, isRecord, overlaps, type PackageEnvironment, readConfigFile, userPath } from './package-evidence.ts'

export interface ScoopRoots {
    readonly root: ConfiguredPath
    readonly global: ConfiguredPath
}

/**
 * Scoop's active roots: the `SCOOP` and `SCOOP_GLOBAL` variables, then `root_path` and
 * `global_path` in its `config.json`, then the defaults. This is the order Scoop itself uses.
 * [Scoop configuration](https://github.com/ScoopInstaller/Scoop/wiki/Configuration)
 */
export function scoopRoots(paths: SystemPaths, env: PackageEnvironment): ScoopRoots {
    const configRoot = environmentValue(env, 'XDG_CONFIG_HOME') ?? join(paths.home, '.config')
    const configPath = join(configRoot, 'scoop', 'config.json')
    const file = readConfigFile(configPath)
    let config: Record<string, unknown> = {}
    if (file && 'blocked' in file) return { root: file, global: file }
    if (file) {
        try {
            const parsed: unknown = JSON.parse(file.text.replace(/^﻿/u, ''))
            if (!isRecord(parsed)) throw new SyntaxError('not an object')
            config = parsed
        } catch {
            const blocked = { blocked: `Could not parse the Scoop configuration at ${configPath}` }
            return { root: blocked, global: blocked }
        }
    }
    function choose(variable: string, key: string, fallback: string): ConfiguredPath {
        const value = environmentValue(env, variable) ?? config[key]
        if (value === undefined || value === null) return { path: fallback }
        return typeof value === 'string' && value ? { path: value } : { blocked: `${key} in ${configPath} is not a path` }
    }
    return { root: choose('SCOOP', 'root_path', join(paths.home, 'scoop')), global: choose('SCOOP_GLOBAL', 'global_path', join(paths.programData, 'scoop')) }
}

/** Scoop's own top-level folders. A root with anything else holds more than Scoop. */
const scoopEntries = new Set(['apps', 'buckets', 'cache', 'persist', 'shims', 'modules', 'workspace'])

function unexpectedEntries(names: readonly string[]): string[] {
    return names.filter((name) => !scoopEntries.has(name.toLowerCase()))
}

function layoutProblem(root: string, names: readonly string[]): string | null {
    const unexpected = unexpectedEntries(names)
    return unexpected.length > 0 ? `${root} holds more than Scoop: ${unexpected.join(', ')}` : null
}

/** The root's entries while the catalog is built, or `null` when the root does not exist. */
function rootEntries(root: string): string[] | { blocked: string } | null {
    try {
        return readdirSync(root)
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null
        return { blocked: `Could not list ${root}` }
    }
}

/** Scoop's catalog identity, shared with the catalog's fallback when reading its configuration fails. */
export const scoopApp = { id: 'scoop', label: 'Scoop', processGuardId: 'scoop-relocation', recordedHardLinks: 'refuse-external' } as const

export function scoopRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const roots = scoopRoots(paths, env)
    const app = scoopApp
    if ('blocked' in roots.root) return { ...app, blocked: roots.root.blocked, paths: [] }
    if ('blocked' in roots.global) return { ...app, blocked: roots.global.blocked, paths: [] }
    const root = userPath(roots.root.path, paths)
    const global = roots.global.path
    if (!root || overlaps(root, global)) return { ...app, paths: [] }
    // Any Scoop root, the default `~scoop` included, moves only when it holds Scoop's own folders.
    // A custom root can be a shared folder, and a stray file anywhere would move as Scoop's data.
    const names = rootEntries(root)
    if (names && 'blocked' in names) return { ...app, blocked: names.blocked, paths: [] }
    const problem = names && layoutProblem(root, names)
    if (problem) return { ...app, blocked: problem, paths: [] }
    return {
        ...app,
        paths: [
            {
                path: root,
                description: 'Scoop installation, apps and persistent data',
                // Scoop links persisted files between `apps` and `persist` with hard links, now and on
                // every later install or update. Both trees move as one, so those links stay on one
                // volume. A hard link that reaches outside the root cannot follow it.
                hardLinks: 'refuse-external',
                async verifyDirectory(target) {
                    if (unexpectedEntries(await readdir(target)).length > 0) return false
                    const releases = join(target, 'apps', 'scoop')
                    if (!(await directEntry(releases, 'directory'))) return false
                    try {
                        const current = await realpath(join(releases, 'current'))
                        if (!isPathInside(current, releases)) return false
                        return directEntry(join(current, 'bin', 'scoop.ps1'), 'file')
                    } catch (error) {
                        if (isUnavailablePath(error)) return false
                        throw error
                    }
                }
            }
        ]
    }
}
