import { join } from 'node:path'

import { listDirectoryNames, pathExists } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp, RelocationPath } from '../types.ts'
import { directEntry, overlaps, type PackageEnvironment, packageManifest, userPath } from './package-evidence.ts'

export function bunRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const root = env.BUN_INSTALL ?? join(paths.home, '.bun')
    const global = userPath(env.BUN_INSTALL_GLOBAL_DIR ?? join(root, 'install', 'global'), paths)
    const cache = userPath(env.BUN_INSTALL_CACHE_DIR ?? join(root, 'install', 'cache'), paths)
    const bin = env.BUN_INSTALL_BIN ?? join(root, 'bin')
    const candidates: RelocationPath[] = []
    if (global && !overlaps(global, bin)) {
        candidates.push({
            path: global,
            description: 'Bun global packages',
            async verifyDirectory(target) {
                const manifest = await packageManifest(target)
                return (
                    !!manifest?.dependencies &&
                    typeof manifest.dependencies === 'object' &&
                    ((await directEntry(join(target, 'bun.lock'), 'file')) || (await directEntry(join(target, 'bun.lockb'), 'file'))) &&
                    (await directEntry(join(target, 'node_modules'), 'directory'))
                )
            }
        })
    }
    if (cache && !overlaps(cache, bin) && (!global || !overlaps(cache, global))) {
        candidates.push({
            path: cache,
            description: 'Bun download cache',
            async verifyDirectory(target) {
                // Projects can point into the global store with symlinks. Leave the cache
                // in place when it contains that shared store.
                if (await pathExists(join(target, 'links'))) return false
                for (const name of await listDirectoryNames(target)) {
                    if (/@\d+\.\d+\.\d+/u.test(name) && typeof (await packageManifest(join(target, name)))?.name === 'string') return true
                }
                return false
            }
        })
    }
    return { id: 'bun', label: 'Bun', processGuardId: 'bun-relocation', paths: candidates }
}
