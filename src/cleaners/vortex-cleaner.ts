import { join } from 'node:path'

import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate } from '../core/types.ts'
import { BaseCleaner } from './base-cleaner.ts'
import { detectUpdaterDirectory } from './helpers.ts'

export class VortexCleaner extends BaseCleaner {
    readonly id = 'vortex'
    readonly label = 'Vortex'
    readonly description = 'Current and abandoned Vortex updater payloads'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const updater = await detectUpdaterDirectory({
            appId: this.id,
            updaterRoot: join(this.paths.localAppData, 'vortex-updater'),
            allowedRoot: this.paths.localAppData,
            label: this.label
        })
        const pending = await detectUpdaterDirectory({
            appId: `${this.id}:legacy`,
            updaterRoot: join(this.paths.localAppData, 'Vortex', 'pending'),
            allowedRoot: this.paths.localAppData,
            label: this.label
        })
        return [...updater, ...pending]
    }
}
