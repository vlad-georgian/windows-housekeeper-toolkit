import { isAbsolute, join } from 'node:path'

import { createFilesystemCandidate, isPathInside, listDirectoryNames, pathExists } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import { type Environment, scoopRoot } from '../helpers.ts'

// Scoop names cached downloads `<app>#<version>#<hash or url>`. Partial downloads keep a
// `.download` or `.aria2` suffix while in progress.
const cachedDownload = /^([^#]+)#([^#]+)#[^#]+$/
const inProgress = /\.(?:download|aria2)$/i

export class ScoopCacheCleaner extends BaseCleaner {
    readonly id = 'scoop-cache'
    readonly appId = 'scoop-cache'
    readonly category = 'destructive-cache'
    readonly label = 'Scoop download cache'
    readonly description = 'Downloaded Scoop app archives and installers'
    readonly implications = 'Scoop downloads archives again to reinstall, reset, or repair apps, and offline reinstalls fail. Installed apps and persisted data are preserved.'
    readonly manualRunningAppCheck = false

    constructor(
        private readonly paths: SystemPaths,
        private readonly environment: Environment = process.env
    ) {
        super()
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = scoopRoot(this.paths, this.environment)
        if (!isPathInside(root, this.paths.home)) return []
        if (!(await pathExists(join(root, 'apps', 'scoop', 'current')))) return []
        const override = this.environment.SCOOP_CACHE
        const cache = override && isAbsolute(override) ? override : join(root, 'cache')
        if (!isPathInside(cache, this.paths.home)) return []

        const candidates: CleanupCandidate[] = []
        for (const name of await listDirectoryNames(cache)) {
            const match = cachedDownload.exec(name)
            if (!match || inProgress.test(name)) continue
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:${name}`,
                path: join(cache, name),
                allowedRoot: cache,
                displayName: `Scoop cached ${match[1]} ${match[2]}`,
                reason: 'Downloaded archive in the Scoop cache',
                type: 'file'
            })
            if (candidate) candidates.push(candidate)
        }
        return candidates
    }
}
