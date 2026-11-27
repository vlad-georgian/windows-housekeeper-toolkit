import { join } from 'node:path'

import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { directEntry, packageManifest, userPath } from './package-evidence.ts'

export function nodejsRelocation(paths: SystemPaths): RelocatableApp {
    const roots = [join(paths.localAppData, 'Programs', 'nodejs'), join(paths.localAppData, 'nodejs')]
    return {
        id: 'nodejs',
        label: 'Node.js',
        processGuardId: 'npm-cache',
        paths: roots
            .filter((root) => userPath(root, paths))
            .map((path) => ({
                path,
                description: 'standalone Node.js distribution',
                async verifyDirectory(target) {
                    if (!(await directEntry(join(target, 'node.exe'), 'file'))) return false
                    const npm = await packageManifest(join(target, 'node_modules', 'npm'))
                    return npm?.name === 'npm' && typeof npm.version === 'string'
                }
            }))
    }
}
