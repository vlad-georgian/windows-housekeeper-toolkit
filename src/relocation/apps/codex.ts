import { join } from 'node:path'

import { inspectReleaseStore } from '../../cleaners/installations/codex-release-store.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'

export function codexRelocation(paths: SystemPaths): RelocatableApp {
    const codexHome = join(paths.home, '.codex')
    return {
        id: 'codex',
        processGuardId: 'codex',
        label: 'Codex',
        preserveMirror: true,
        paths: [
            {
                path: codexHome,
                description: 'user data and standalone and daemon release stores',
                verifyLegacyTarget: async (target) => !!((await inspectReleaseStore(target, 'standalone')) ?? (await inspectReleaseStore(target, 'app-server-daemon')))
            },
            {
                path: join(paths.localAppData, 'Programs', 'OpenAI', 'Codex'),
                description: 'standalone installation',
                linkedSelector: { owner: codexHome, entry: 'bin', selector: join('packages', 'standalone', 'current', 'bin') }
            },
            { path: join(paths.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex'), description: 'desktop profile' }
        ]
    }
}
