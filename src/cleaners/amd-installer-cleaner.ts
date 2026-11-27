import { join } from 'node:path'

import { createFilesystemCandidate } from '../core/filesystem/index.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate } from '../core/types.ts'
import { BaseCleaner } from './base-cleaner.ts'

export class AmdInstallerCleaner extends BaseCleaner {
    readonly id = 'amd-installers'
    readonly label = 'AMD installer extractions'
    readonly description = 'Extracted AMD driver and utility setup files'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const candidates: CleanupCandidate[] = []
        for (const [location, name] of [
            [join('Chipset_Software', 'Binaries'), 'AMD chipset installer binaries'],
            [join('Chipset_Software', 'Packages'), 'AMD chipset installer packages']
        ] as const) {
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:${location}`,
                path: join(this.paths.systemDrive, 'AMD', location),
                allowedRoot: this.paths.systemDrive,
                displayName: name,
                reason: 'Extracted files from the AMD chipset installer',
                type: 'directory'
            })
            if (candidate && (candidate.fileCount ?? 0) > 0) candidates.push(candidate)
        }
        return candidates
    }
}
