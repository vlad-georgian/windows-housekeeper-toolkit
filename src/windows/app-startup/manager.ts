import type { SystemPaths } from '../../core/system-paths.ts'
import { type AppId, appNames } from '../app-catalog.ts'
import type { StartupBackend } from './backend.ts'
import { nameMatches, readPreferences, savePreferences, type StartupPreference } from './preferences.ts'
import { settingsGuide } from './status.ts'

/**
 * Disables one verified HKCU Run entry of an app and saves its previous value for restore.
 * The CLI commands and the launch menu share this. Returns a message describing the result.
 */
export async function disableSignInEntry(paths: SystemPaths, backend: StartupBackend, app: AppId, entryName?: string): Promise<string> {
    const { entries, packagedApps } = await backend.inspect()
    const preferences = await readPreferences(paths)
    const appPreferences = preferences.filter((item) => item.app === app && (!entryName || nameMatches(item.name, entryName)))
    const matches = entries.filter((entry) => entry.app === app && entry.supported && (!entryName || nameMatches(entry.name, entryName)))
    const existing = appPreferences.filter((pref) => !matches.some((entry) => nameMatches(entry.name, pref.name)))
    if (matches.length + existing.length > 1) {
        throw new Error(`Choose one startup entry by name: ${[...matches, ...existing].map((entry) => entry.name).join(', ')}.`)
    }
    const entry = matches[0]
    const saved = appPreferences[0]
    if (!entry && !saved) {
        throw new Error(`No matching manageable startup entry found for ${appNames[app]}.${packagedApps.includes(app) ? ` ${settingsGuide}` : ''}`)
    }
    if (saved?.restorePending) throw new Error(`Finish restoring ${saved.name} before disabling it again.`)
    if (!entry && saved) {
        const result = await backend.changeRunValue(saved, false)
        return `${saved.name} ${result === 'changed' ? 'was disabled again' : 'is already absent'}. The disable preference is saved.`
    }
    if (!entry || (entry.valueKind !== 'String' && entry.valueKind !== 'ExpandString')) {
        throw new Error('The startup entry uses an unsupported registry value type.')
    }
    if (saved && (saved.command !== entry.command || saved.valueKind !== entry.valueKind)) {
        throw new Error(`The current command for ${entry.name} differs from the saved preference.`)
    }
    if (!saved && preferences.some((item) => nameMatches(item.name, entry.name))) {
        throw new Error(`The HKCU Run value ${entry.name} belongs to another saved startup preference.`)
    }
    const preference: StartupPreference = saved ?? {
        app,
        name: entry.name,
        command: entry.command,
        valueKind: entry.valueKind,
        target: entry.target,
        restorePending: false
    }
    if (!saved) await savePreferences(paths, [...preferences, preference])
    await backend.changeRunValue(preference, false)
    return `Disabled ${preference.name} and saved its previous HKCU Run value.`
}

/** Restores the saved HKCU Run value of an app's entry and forgets its preference. */
export async function restoreSignInEntry(paths: SystemPaths, backend: StartupBackend, app: AppId, entryName?: string): Promise<string> {
    const preferences = await readPreferences(paths)
    const matches = preferences.filter((item) => item.app === app && (!entryName || nameMatches(item.name, entryName)))
    if (matches.length > 1) throw new Error(`Choose one startup entry by name: ${matches.map((item) => item.name).join(', ')}.`)
    const preference = matches[0]
    if (!preference) throw new Error(`No matching saved startup change for ${appNames[app]}. ${settingsGuide}`)
    if (!preference.restorePending) {
        await savePreferences(
            paths,
            preferences.map((item) => (item === preference ? { ...item, restorePending: true } : item))
        )
    }
    await backend.changeRunValue(preference, true)
    await savePreferences(
        paths,
        preferences.filter((item) => item !== preference)
    )
    return `Restored the previous HKCU Run value for ${preference.name}.`
}

/** Applies every saved disable preference again. Entries with a restore in progress are left alone. */
export async function reapplyStartupPreferences(paths: SystemPaths, backend: StartupBackend): Promise<{ messages: string[]; failures: number }> {
    const preferences = (await readPreferences(paths)).filter((item) => !item.restorePending)
    const messages: string[] = []
    let failures = 0
    for (const preference of preferences) {
        try {
            const result = await backend.changeRunValue(preference, false)
            messages.push(`${appNames[preference.app]} startup · ${preference.name} · ${result === 'changed' ? 'disabled' : 'already absent'}`)
        } catch (error) {
            failures++
            messages.push(`${appNames[preference.app]} startup · ${preference.name} · ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return { messages, failures }
}
