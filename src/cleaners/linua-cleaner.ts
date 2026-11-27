import { join } from 'node:path'

import { createFilesystemCandidate } from '../core/filesystem/index.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate } from '../core/types.ts'
import { BaseCleaner } from './base-cleaner.ts'

export class LinuaCleaner extends BaseCleaner {
    readonly id = 'linua'
    readonly label = 'Linua'
    readonly description = 'Linua updater downloads, when present'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = join(this.paths.localAppData, 'LinuaUpdater')
        const names = ['installer.exe', 'update.zip', 'package.zip']
        const candidates: CleanupCandidate[] = []
        for (const location of [...names, ...names.map((name) => join('pending', name))]) {
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
