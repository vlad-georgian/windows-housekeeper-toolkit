import { isAbsolute, join } from 'node:path'

import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../core/types.ts'
import { BaseCleaner } from './base-cleaner.ts'
import { detectCodexInstallations, removeCodexInstallation } from './codex-installations.ts'
import { detectNamedCaches } from './helpers.ts'

export class CodexCleaner extends BaseCleaner {
    readonly id = 'codex'
    readonly label = 'Codex'
    readonly description = 'Regenerable Codex caches and superseded releases'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    private get codexHome(): string {
        const override = process.env.CODEX_HOME
        return override && isAbsolute(override) ? override : join(this.paths.home, '.codex')
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = this.codexHome
        const [caches, installations] = await Promise.all([
            detectNamedCaches(this.id, this.label, root, [
                [join('cache', 'bundled_plugin_exclusions'), 'Regenerable bundled plugin exclusions cache'],
                [join('cache', 'codex_app_directory'), 'Regenerable application directory cache'],
                [join('cache', 'codex_apps_server_info'), 'Regenerable app server metadata cache'],
                [join('cache', 'codex_apps_tools'), 'Regenerable app tool metadata cache'],
                [join('cache', 'remote_plugin_catalog'), 'Regenerable remote plugin catalog cache']
            ]),
            detectCodexInstallations(root, this.paths)
        ])
        return [...caches, ...installations]
    }

    override remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        if (candidate.id.startsWith('codex:release:') || candidate.id.startsWith('codex:npm:')) {
            return removeCodexInstallation(candidate, this.codexHome, () => super.remove(candidate, callbacks))
        }
        return super.remove(candidate, callbacks)
    }
}
