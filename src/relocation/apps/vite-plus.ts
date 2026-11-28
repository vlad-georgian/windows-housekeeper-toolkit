import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { isPathInside, isUnavailablePath } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp, RelocationPath } from '../types.ts'
import { directEntry, type PackageEnvironment, packageManifest, samePath, userPath } from './package-evidence.ts'

export function vitePlusRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const root = join(paths.localAppData, 'vite-plus')
    const bin = userPath(env.VP_BIN_DIR ?? join(root, 'bin'), paths)
    const data = userPath(env.VP_DATA_DIR ?? join(root, 'data'), paths)
    const candidates: RelocationPath[] = []
    async function ownsData(target: string): Promise<boolean> {
        if (!bin || !(await directEntry(join(bin, 'vp.exe'), 'file'))) return false
        try {
            const current = await realpath(join(target, 'current'))
            if (!isPathInside(current, target)) return false
            const manifest = await packageManifest(current)
            const dependencies = manifest?.dependencies
            return !!dependencies && typeof dependencies === 'object' && 'vite-plus' in dependencies && typeof dependencies['vite-plus'] === 'string'
        } catch (error) {
            if (isUnavailablePath(error)) return false
            throw error
        }
    }
    if (data && bin && !samePath(data, bin) && !isPathInside(bin, data)) {
        candidates.push({ path: data, description: 'Vite+ releases and managed runtimes', verifyDirectory: ownsData })
    }
    const cache = join(root, 'cache')
    // The installation identifies its conventional cache and state directories. A custom cache
    // path may be shared with other tools.
    if (data && samePath(data, join(root, 'data'))) {
        for (const path of [cache, join(root, 'state')]) {
            if (!userPath(path, paths) || (path === cache && env.VP_CACHE_DIR && !samePath(path, env.VP_CACHE_DIR))) continue
            candidates.push({
                path,
                description: 'Vite+ user data',
                async verifyDirectory() {
                    try {
                        return await ownsData(await realpath(data))
                    } catch (error) {
                        if (isUnavailablePath(error)) return false
                        throw error
                    }
                }
            })
        }
    }
    return { id: 'vite-plus', label: 'Vite+', processGuardId: 'vite-plus-relocation', paths: candidates }
}
