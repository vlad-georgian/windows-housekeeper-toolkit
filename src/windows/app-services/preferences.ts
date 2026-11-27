import { readState, writeState } from '../../core/state.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import { isArrayOf, isRecord } from '../app-catalog.ts'
import { isAppService, isAutomatic, type AppService, type AutomaticMode } from './backend.ts'

export interface ServicePreference {
    readonly service: AppService & { readonly mode: AutomaticMode }
    readonly restorePending: boolean
}

const stateName = 'app-service-startup.json'

function isPreference(value: unknown): value is ServicePreference {
    return isRecord(value) && isAppService(value.service) && isAutomatic(value.service.mode) && typeof value.restorePending === 'boolean'
}

export async function readServicePreferences(paths: SystemPaths): Promise<ServicePreference[]> {
    const preferences = await readState<unknown>(paths, stateName, [])
    if (!isArrayOf(preferences, isPreference) || new Set(preferences.map(({ service }) => service.name.toLowerCase())).size !== preferences.length) {
        throw new Error(`App service startup preferences in ${stateName} are invalid.`)
    }
    return preferences
}

export function saveServicePreferences(paths: SystemPaths, preferences: readonly ServicePreference[]): Promise<void> {
    return writeState(paths, stateName, preferences)
}
