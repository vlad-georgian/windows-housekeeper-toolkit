import { join } from 'node:path'

import { createFilesystemCandidate } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'

export class LinuaCleaner extends BaseCleaner {
    readonly id = 'linua'
    readonly appId = 'linua'
    readonly category = 'old-installations'
    readonly label = 'Linua'
    readonly description = 'Linua updater downloads for installed updates, when present'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = join(this.paths.localAppData, 'LinuaUpdater')
        // Payloads under `pending` are a staged update awaiting installation and are preserved.
        const names = ['installer.exe', 'update.zip', 'package.zip']
        const candidates: CleanupCandidate[] = []
        for (const location of names) {
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:${location}`,
                path: join(root, location),
                allowedRoot: this.paths.localAppData,
                displayName: `Linua cached ${location}`,
                reason: 'Downloaded self-update payload',
                type: 'file'
            })
            if (candidate) candidates.push(candidate)
        }
        return candidates
    }
}
