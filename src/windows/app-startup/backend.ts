import type { SystemPaths } from '../../core/system-paths.ts'
import { type AppId, type AppInventory, getAppInventory } from '../app-catalog.ts'
import { getScheduledStartupEntries, getStartupEntries, type StartupEntry } from './inventory.ts'
import type { StartupPreference } from './preferences.ts'
import { changeRunValue } from './registry.ts'

/** Everything the startup workflow knows about the machine's app startup entries. */
export interface StartupSnapshot {
    /** Entries from every inspected mechanism. Only `supported` entries can be changed. */
    readonly entries: readonly StartupEntry[]
    readonly warnings: readonly string[]
    /** Apps with packaged startup tasks, which Windows Settings manages. */
    readonly packagedApps: readonly AppId[]
}

/**
 * The only way startup management reads or writes Windows. Tests inject a fake so they never
 * touch the real registry, Startup folders, or scheduled tasks.
 */
export interface StartupBackend {
    inspect(): Promise<StartupSnapshot>
    /** Removes (`restore` false) or rewrites (`restore` true) the verified HKCU Run value of a preference. */
    changeRunValue(preference: StartupPreference, restore: boolean): Promise<'changed' | 'unchanged'>
}

/** The Windows backend. It reads the app inventory once, on first use. */
export function createSystemStartupBackend(paths: SystemPaths): StartupBackend {
    let inventory: Promise<AppInventory> | undefined
    const loadInventory = (): Promise<AppInventory> => (inventory ??= getAppInventory(paths))
    return {
        async inspect() {
            const apps = await loadInventory()
            const [startup, scheduled] = await Promise.all([getStartupEntries(apps), getScheduledStartupEntries(apps)])
            return {
                entries: [...startup.entries, ...scheduled.entries],
                warnings: [...apps.warnings, ...startup.warnings, ...scheduled.warnings],
                packagedApps: [...new Set(apps.packages.filter((item) => item.tasks.length > 0).map((item) => item.id))]
            }
        },
        async changeRunValue(preference, restore) {
            return changeRunValue(await loadInventory(), preference, restore)
        }
    }
}
