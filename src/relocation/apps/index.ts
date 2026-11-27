import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { claudeCodeRelocation } from './claude-code.ts'
import { claudeDesktopRelocation } from './claude-desktop.ts'
import { codexRelocation } from './codex.ts'
import { githubDesktopRelocation } from './github-desktop.ts'
import { nodejsRelocation } from './nodejs.ts'
import { npmRelocation } from './npm.ts'
import type { PackageEnvironment } from './package-evidence.ts'
import { scoopRelocation } from './scoop.ts'
import { vitePlusRelocation } from './vite-plus.ts'
import { vscodeExtensionsRelocation } from './vscode.ts'

/** The relocation catalog in menu order. Add an app in its own file and list it here. */
export function createRelocationCatalog(paths: SystemPaths, env: PackageEnvironment = process.env, machineChocolatey?: MachineChocolateyRoot): RelocatableApp[] {
    return [
        githubDesktopRelocation(paths),
        vscodeExtensionsRelocation(paths),
        codexRelocation(paths),
        claudeCodeRelocation(paths),
        claudeDesktopRelocation(paths),
        scoopRelocation(paths, env),
        vitePlusRelocation(paths, env),
        nodejsRelocation(paths),
        npmRelocation(paths, env),
        bunRelocation(paths, env),
        chocolateyRelocation(paths, env, machineChocolatey ?? (async () => undefined))
    ]
}
import { bunRelocation } from './bun.ts'
import { chocolateyRelocation, type MachineChocolateyRoot } from './chocolatey.ts'
