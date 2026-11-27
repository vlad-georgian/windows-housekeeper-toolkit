import { join } from 'node:path'

import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import { detectUpdaterDirectory } from '../helpers.ts'

export class ChatboxCleaner extends BaseCleaner {
    readonly id = 'chatbox'
    readonly appId = 'chatbox'
    readonly category = 'old-installations'
    readonly label = 'Chatbox'
    readonly description = 'Downloaded Chatbox self-update installers'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectUpdaterDirectory({
            appId: this.id,
            updaterRoot: join(this.paths.localAppData, 'xyz.chatboxapp.app-updater'),
            allowedRoot: this.paths.localAppData,
            label: this.label
        })
    }
}
