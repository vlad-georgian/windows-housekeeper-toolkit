import { join } from 'node:path'

import { listDirectoryNames } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp, RelocationPath } from '../types.ts'
import { directEntry, type PackageEnvironment, packageManifest, userPath } from './package-evidence.ts'

async function hasPackage(store: string, scope = ''): Promise<boolean> {
    for (const name of await listDirectoryNames(store)) {
        if (name.startsWith('.')) continue
        const path = join(store, name)
        if (!(await directEntry(path, 'directory'))) continue
        if (!scope && name.startsWith('@')) {
            if (await hasPackage(path, `${name}/`)) return true
            continue
        }
        const manifest = await packageManifest(path)
        if (manifest?.name === `${scope}${name}` && typeof manifest.version === 'string') return true
    }
    return false
}

export function npmRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const prefix = userPath(env.NPM_CONFIG_PREFIX ?? join(paths.roamingAppData, 'npm'), paths)
    const cache = userPath(env.NPM_CONFIG_CACHE ?? join(paths.localAppData, 'npm-cache'), paths)
    const candidates: RelocationPath[] = []
    if (prefix) candidates.push({ path: join(prefix, 'node_modules'), description: 'npm global packages', verifyDirectory: hasPackage })
    if (cache) {
        candidates.push({
            path: join(cache, '_cacache'),
            description: 'npm content cache',
            async verifyDirectory(target) {
                return (await directEntry(join(target, 'content-v2'), 'directory')) && (await directEntry(join(target, 'index-v5'), 'directory'))
            }
        })
    }
    return { id: 'npm', label: 'npm', processGuardId: 'npm-cache', paths: candidates }
}
