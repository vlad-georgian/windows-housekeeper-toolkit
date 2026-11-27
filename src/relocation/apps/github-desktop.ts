import { join } from 'node:path'

import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'

/** GitHub Desktop's per-user Squirrel installation and its app data. */
export function githubDesktopRelocation(paths: SystemPaths): RelocatableApp {
    return {
        id: 'github-desktop',
        processGuardId: 'github-desktop',
        label: 'GitHub Desktop',
        paths: [
            { path: join(paths.localAppData, 'GitHubDesktop'), description: 'installation' },
            { path: join(paths.roamingAppData, 'GitHub Desktop'), description: 'data' }
        ]
    }
}
