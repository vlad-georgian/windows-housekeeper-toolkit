import { join } from 'node:path'

import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate } from '../core/types.ts'
import { BaseCleaner } from './base-cleaner.ts'
import { detectNamedCaches } from './helpers.ts'

export class NugetCacheCleaner extends BaseCleaner {
    readonly id = 'nuget-cache'
    readonly label = 'NuGet / Chocolatey download cache'
    readonly description = 'Downloaded NuGet archives, including old Chocolatey installers'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        const nugetRoot = join(this.paths.localAppData, 'NuGet')
        return detectNamedCaches(this.id, 'NuGet', nugetRoot, [
            ['Cache', 'Regenerable NuGet package download cache'],
            ['v3-cache', 'Regenerable NuGet v3 HTTP cache']
        ])
    }
}
