import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { isPathInside, isUnavailablePath } from '../../core/filesystem/paths.ts'
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

export function scoopRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const roots = scoopRoots(paths, env)
    const app = { id: 'scoop', label: 'Scoop', processGuardId: 'scoop-relocation' }
    if ('blocked' in roots.root) return { ...app, blocked: roots.root.blocked, paths: [] }
    if ('blocked' in roots.global) return { ...app, blocked: roots.global.blocked, paths: [] }
    const root = userPath(roots.root.path, paths)
    const global = roots.global.path
    if (!root || overlaps(root, global)) return { ...app, paths: [] }
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
