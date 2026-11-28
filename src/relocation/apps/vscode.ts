import { join } from 'node:path'

import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'

/** VS Code's installed extensions. Settings and workspace data stay in place. */
export function vscodeExtensionsRelocation(paths: SystemPaths): RelocatableApp {
    return {
        id: 'vscode-extensions',
        processGuardId: 'vscode',
        label: 'Visual Studio Code extensions',
        paths: [{ path: join(paths.home, '.vscode', 'extensions'), description: 'installed extensions' }]
    }
}
