import { readState, writeState } from '../../core/state.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import { type AppId, isAppId, isArrayOf, isRecord, isString } from '../app-catalog.ts'

export interface StartupPreference {
    app: AppId
    name: string
    target: string
    command: string
    valueKind: 'String' | 'ExpandString'
    restorePending: boolean
}

function isStartupPreference(value: unknown): value is StartupPreference {
    return (
        isRecord(value) &&
        isAppId(value.app) &&
        isString(value.name) &&
        value.name.length > 0 &&
        isString(value.target) &&
        isString(value.command) &&
        (value.valueKind === 'String' || value.valueKind === 'ExpandString') &&
        typeof value.restorePending === 'boolean'
    )
}

const startupState = 'app-startup.json'

export async function readPreferences(paths: SystemPaths): Promise<StartupPreference[]> {
    const preferences = await readState<unknown>(paths, startupState, [])
    if (!isArrayOf(preferences, isStartupPreference)) {
        throw new Error(`Startup preferences in ${startupState} are invalid.`)
    }
    return preferences
}

export function nameMatches(actual: string, requested: string): boolean {
    return actual.toLowerCase() === requested.toLowerCase()
}

export async function savePreferences(paths: SystemPaths, preferences: StartupPreference[]): Promise<void> {
    await writeState(paths, startupState, preferences)
}
