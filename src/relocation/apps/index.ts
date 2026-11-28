import { errorMessage } from '../../core/format.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { bunRelocation } from './bun.ts'
import { chocolateyRelocation } from './chocolatey.ts'
import { claudeCodeRelocation } from './claude-code.ts'
import { claudeDesktopRelocation } from './claude-desktop.ts'
import { codexRelocation } from './codex.ts'
import { githubDesktopRelocation } from './github-desktop.ts'
import { nodejsRelocation } from './nodejs.ts'
import { npmRelocation } from './npm.ts'
import type { PackageSources } from './package-evidence.ts'
import { scoopRelocation } from './scoop.ts'
import { vitePlusRelocation } from './vite-plus.ts'
import { vscodeExtensionsRelocation } from './vscode.ts'

/**
 * A package manager whose configuration is read while the catalog is built. An unexpected
 * error refuses only that manager, so the launch menu, cleanup and dry runs still start.
 */
function packageManager(app: Pick<RelocatableApp, 'id' | 'label' | 'processGuardId' | 'recordedHardLinks'>, build: () => RelocatableApp): RelocatableApp {
    try {
        return build()
    } catch (error) {
        return { ...app, blocked: `Could not read the ${app.label} configuration. ${errorMessage(error)}`, paths: [] }
    }
}

/**
 * The relocation catalog in menu order. Add an app in its own file and list it here. Package
 * managers read their locations from `sources`, never from the ambient process environment.
 */
export function createRelocationCatalog(paths: SystemPaths, sources: PackageSources): RelocatableApp[] {
    const { env } = sources
    return [
        githubDesktopRelocation(paths),
        vscodeExtensionsRelocation(paths),
        codexRelocation(paths),
        claudeCodeRelocation(paths),
        claudeDesktopRelocation(paths),
        packageManager({ id: 'scoop', label: 'Scoop', processGuardId: 'scoop-relocation', recordedHardLinks: 'refuse-external' }, () => scoopRelocation(paths, env)),
        packageManager({ id: 'vite-plus', label: 'Vite+', processGuardId: 'vite-plus-relocation' }, () => vitePlusRelocation(paths, env)),
        nodejsRelocation(paths),
        packageManager({ id: 'npm', label: 'npm', processGuardId: 'npm-cache' }, () => npmRelocation(paths, env)),
        packageManager({ id: 'bun', label: 'Bun', processGuardId: 'bun-relocation', recordedHardLinks: 'report-external' }, () => bunRelocation(paths, env)),
        packageManager({ id: 'chocolatey', label: 'Chocolatey (per-user)', processGuardId: 'chocolatey-cache' }, () => chocolateyRelocation(paths, env, sources.machineChocolatey))
    ]
}
