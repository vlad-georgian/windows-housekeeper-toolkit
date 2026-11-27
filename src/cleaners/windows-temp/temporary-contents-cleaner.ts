import { createContentsCandidate, removeContentsCandidate } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'

/**
 * Cleans the contents of one per-user Windows temporary directory and keeps the directory.
 * Every entry is eligible regardless of age. Entries Windows will not release are skipped.
 */
export abstract class TemporaryContentsCleaner extends BaseCleaner {
    // No running-app check applies: Windows refuses to delete files that are in use, and those
    // entries are skipped. The ID is deliberately not a key of the process-guard catalog.
    readonly appId = 'windows-temporary-files'
    readonly category = 'windows-temp'

    protected abstract readonly root: string
    /** The only conventional locations the root may equal or lie inside. */
    protected abstract readonly allowed: readonly string[]
    protected abstract readonly reason: string

    constructor(protected readonly paths: SystemPaths) {
        super()
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return createContentsCandidate({
            id: `${this.id}:contents`,
            root: this.root,
            allowed: this.allowed,
            displayName: `${this.label} contents`,
            reason: this.reason
        }).then((candidate) => (candidate ? [candidate] : []))
    }

    override remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        return removeContentsCandidate(candidate, callbacks)
    }
}
