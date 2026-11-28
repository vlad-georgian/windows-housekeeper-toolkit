import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { claudeCodeRelocation } from './claude-code.ts'
import { claudeDesktopRelocation } from './claude-desktop.ts'
import { codexRelocation } from './codex.ts'
import { githubDesktopRelocation } from './github-desktop.ts'
import { vscodeExtensionsRelocation } from './vscode.ts'

/** The relocation catalog in menu order. Add an app in its own file and list it here. */
export function createRelocationCatalog(paths: SystemPaths): RelocatableApp[] {
    return [githubDesktopRelocation(paths), vscodeExtensionsRelocation(paths), codexRelocation(paths), claudeCodeRelocation(paths), claudeDesktopRelocation(paths)]
}
