import type { SystemPaths } from '../../core/system-paths.ts'
import type { AppCleaner } from '../../core/types.ts'
import { InternetCacheCleaner } from './internet-cache-cleaner.ts'
import { UserTempCleaner } from './user-temp-cleaner.ts'

/** Per-user Windows temporary directory cleaners, in checklist order. */
export function createWindowsTempCleaners(paths: SystemPaths): AppCleaner[] {
    return [new UserTempCleaner(paths), new InternetCacheCleaner(paths)]
}
