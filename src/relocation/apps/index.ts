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
 * The relocation catalog in menu order. Add an app in its own file and list it here. Package
 * managers read their locations from `sources`, never from the ambient process environment.
 */
export function createRelocationCatalog(paths: SystemPaths, sources: PackageSources): RelocatableApp[] {
    return [
        githubDesktopRelocation(paths),
        vscodeExtensionsRelocation(paths),
        codexRelocation(paths),
        claudeCodeRelocation(paths),
        claudeDesktopRelocation(paths),
        scoopRelocation(paths, sources.env),
        vitePlusRelocation(paths, sources.env),
        nodejsRelocation(paths),
        npmRelocation(paths, sources.env),
        bunRelocation(paths, sources.env),
        chocolateyRelocation(paths, sources.env, sources.machineChocolatey)
    ]
}
