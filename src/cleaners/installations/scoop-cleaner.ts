import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { listWindowsProcesses, type ProcessLister } from '../../windows/processes.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import { type Environment, scoopRoot } from '../helpers.ts'
import { detectScoopInstallations, prepareScoopRemoval } from './scoop-installations.ts'

export class ScoopInstallationCleaner extends BaseCleaner {
    readonly id = 'scoop-versions'
    readonly appId = 'scoop'
    readonly category = 'old-installations'
    readonly label = 'Scoop'
    readonly description = 'Superseded app versions, including Node.js. Persistent data is preserved.'
    // Detection and removal check the running processes against each version themselves.
    readonly manualRunningAppCheck = false

    constructor(
        private readonly paths: SystemPaths,
        private readonly environment: Environment = process.env,
        private readonly listProcesses: ProcessLister = listWindowsProcesses
    ) {
        super()
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectScoopInstallations(scoopRoot(this.paths, this.environment), this.paths.home, this.listProcesses)
    }

    override async remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        await prepareScoopRemoval(candidate, scoopRoot(this.paths, this.environment), this.listProcesses, callbacks)
        return super.remove(candidate, callbacks)
    }
}
