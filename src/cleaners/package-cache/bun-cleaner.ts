import { isAbsolute, join } from 'node:path'

import { createFilesystemCandidate, isPathInside, listDirectoryNames } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import type { Environment } from '../helpers.ts'

// Bun stores each downloaded package version as `<name>@<version>@@@<n>`. The unversioned
// `<name>` directories only index those versions and stay in place.
const versionedPackage = /^(.+)@([^@]+)@@@\d+$/

export class BunCacheCleaner extends BaseCleaner {
    readonly id = 'bun-cache'
    readonly appId = 'bun-cache'
    readonly category = 'destructive-cache'
    readonly label = 'Bun package cache'
    readonly description = 'Downloaded Bun package versions'
    readonly implications =
        'Bun downloads packages again on the next install, and offline installs fail until the cache refills. Installed node_modules and cache entries hard-linked into projects are preserved.'
    // Bun runs this tool and routinely runs development servers.
    readonly manualRunningAppCheck = false

    constructor(
        private readonly paths: SystemPaths,
        private readonly environment: Environment = process.env
    ) {
        super()
    }

    private get cacheRoot(): string {
        const { BUN_INSTALL_CACHE_DIR: cacheDirectory, BUN_INSTALL: installDirectory } = this.environment
        if (cacheDirectory && isAbsolute(cacheDirectory)) return cacheDirectory
        const install = installDirectory && isAbsolute(installDirectory) ? installDirectory : join(this.paths.home, '.bun')
        return join(install, 'install', 'cache')
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = this.cacheRoot
        if (!isPathInside(root, this.paths.home)) return []
        const candidates: CleanupCandidate[] = []
        for (const name of await listDirectoryNames(root)) {
            const entries = name.startsWith('@') ? (await listDirectoryNames(join(root, name))).map((child) => join(name, child)) : [name]
            for (const entry of entries) {
                const match = versionedPackage.exec(entry.replaceAll('\\', '/'))
                if (!match) continue
                // Hard-linked files make the candidate unverifiable, so packages that projects
                // share with the cache are never offered.
                const candidate = await createFilesystemCandidate({
                    id: `${this.id}:${entry}`,
                    path: join(root, entry),
                    allowedRoot: root,
                    displayName: `Bun cached ${match[1]}@${match[2]}`,
                    reason: 'Downloaded package version in the Bun install cache',
                    type: 'directory'
                })
                if (candidate) candidates.push(candidate)
            }
        }
        return candidates
    }
}
