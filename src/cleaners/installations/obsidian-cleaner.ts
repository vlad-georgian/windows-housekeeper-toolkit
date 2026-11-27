import { join } from 'node:path'

import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import { detectUpdaterDirectory } from '../helpers.ts'

export class ObsidianCleaner extends BaseCleaner {
    readonly id = 'obsidian'
    readonly appId = 'obsidian'
    readonly category = 'old-installations'
    readonly label = 'Obsidian'
    readonly description = 'Downloaded Obsidian self-update installers'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectUpdaterDirectory({
            appId: this.id,
            updaterRoot: join(this.paths.localAppData, 'obsidian-updater'),
            allowedRoot: this.paths.localAppData,
            label: this.label
        })
    }
}
