import { TemporaryContentsCleaner } from './temporary-contents-cleaner.ts'

export class UserTempCleaner extends TemporaryContentsCleaner {
    readonly id = 'user-temp'
    readonly label = 'Per-user Temp'
    readonly description = 'Files in the current user’s Temp directory'
    readonly implications = 'Files that apps hold open are skipped. Apps recreate the scratch files they still need.'
    protected readonly reason = 'Everything in the per-user Temp directory; the directory itself is kept'

    protected get root(): string {
        return this.paths.temp
    }
}
