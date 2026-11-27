import { join } from 'node:path'

import { TemporaryContentsCleaner } from './temporary-contents-cleaner.ts'

export class InternetCacheCleaner extends TemporaryContentsCleaner {
    readonly id = 'internet-cache'
    readonly label = 'Temporary Internet Files'
    readonly description = 'Web content cached for the current user by Windows'
    readonly implications = 'Windows and apps using its web cache download that content again. Files in use are skipped.'
    protected readonly reason = 'Everything in the per-user Temporary Internet Files cache; the directory itself is kept'

    protected get root(): string {
        return join(this.paths.localAppData, 'Microsoft', 'Windows', 'INetCache')
    }
}
