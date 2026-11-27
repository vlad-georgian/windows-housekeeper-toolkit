import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { githubDesktopRelocation } from './github-desktop.ts'
import { vscodeExtensionsRelocation } from './vscode.ts'

/** The relocation catalog in menu order. Add an app in its own file and list it here. */
export function createRelocationCatalog(paths: SystemPaths): RelocatableApp[] {
    return [githubDesktopRelocation(paths), vscodeExtensionsRelocation(paths)]
}
