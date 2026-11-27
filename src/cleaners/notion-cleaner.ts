import { join } from 'node:path'

import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate } from '../core/types.ts'
import { BaseCleaner } from './base-cleaner.ts'
import { detectUpdaterDirectory } from './helpers.ts'

export class NotionCleaner extends BaseCleaner {
    readonly id = 'notion'
    readonly label = 'Notion'
    readonly description = 'Downloaded and pending Notion installers'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectUpdaterDirectory({
            appId: this.id,
            updaterRoot: join(this.paths.localAppData, 'notion-updater'),
            allowedRoot: this.paths.localAppData,
            label: this.label
        })
    }
}
