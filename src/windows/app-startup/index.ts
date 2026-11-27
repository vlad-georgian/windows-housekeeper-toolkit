import type { SystemPaths } from '../../core/system-paths.ts'
import type { AppId } from '../app-catalog.ts'
import { createSystemStartupBackend } from './backend.ts'
import { disableSignInEntry, reapplyStartupPreferences as reapplyPreferences, restoreSignInEntry } from './manager.ts'

export { openStartupSettings, showStartup } from './status.ts'

export async function disableStartup(paths: SystemPaths, app: AppId, entryName?: string): Promise<void> {
    console.log(await disableSignInEntry(paths, createSystemStartupBackend(paths), app, entryName))
}

export async function restoreStartup(paths: SystemPaths, app: AppId, entryName?: string): Promise<void> {
    console.log(await restoreSignInEntry(paths, createSystemStartupBackend(paths), app, entryName))
}

export function reapplyStartupPreferences(paths: SystemPaths): Promise<{ messages: string[]; failures: number }> {
    return reapplyPreferences(paths, createSystemStartupBackend(paths))
}
