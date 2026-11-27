import { join } from 'node:path'

import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import { detectNamedCaches } from '../helpers.ts'

export class NugetCacheCleaner extends BaseCleaner {
    readonly implications =
        'NuGet downloads packages again on the next restore, and offline restores fail until the cache refills. The global packages folder that projects use is preserved.'
    // .NET build servers and IDEs routinely run during manual cleanup.
    readonly manualRunningAppCheck = false
    readonly id = 'nuget-cache'
    readonly appId = 'nuget-cache'
    readonly category = 'destructive-cache'
    readonly label = 'NuGet download cache'
    readonly description = 'Downloaded NuGet package archives and HTTP metadata'

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
