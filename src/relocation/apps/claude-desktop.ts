import { join } from 'node:path'

import { readSmallTextFile } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'

export function claudeDesktopRelocation(paths: SystemPaths): RelocatableApp {
    const families = ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t']
    return {
        id: 'claude-desktop',
        processGuardId: 'claude-desktop',
        label: 'Claude Desktop',
        preserveMirror: true,
        paths: [
            { path: join(paths.localAppData, 'AnthropicClaude'), description: 'per-user desktop installation' },
            { path: join(paths.roamingAppData, 'Claude'), description: 'desktop profile' },
            {
                path: join(paths.localAppData, 'Claude-Data'),
                description: 'desktop data',
                verifyLegacyTarget: async (target) =>
                    (await Promise.all(families.map((family) => readSmallTextFile(join(target, family, 'claude_desktop_config.json'), target)))).some((config) => config !== null)
            },
            ...families.map((family) => ({ path: join(paths.localAppData, 'Packages', family, 'LocalCache', 'Roaming', 'Claude'), description: 'packaged desktop profile' }))
        ]
    }
}
