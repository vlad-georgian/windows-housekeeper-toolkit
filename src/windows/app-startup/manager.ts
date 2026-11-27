import type { SystemPaths } from '../../core/system-paths.ts'
import { type AppId, appNames } from '../app-catalog.ts'
import type { StartupBackend } from './backend.ts'
import type { StartupEntry } from './inventory.ts'
import { nameMatches, readPreferences, savePreferences, type StartupPreference } from './preferences.ts'
import { settingsGuide } from './status.ts'

/** Whether the saved preference's HKCU Run value is currently registered, with any command. */
export function isRegistered(entries: readonly StartupEntry[], preference: StartupPreference): boolean {
    return entries.some((entry) => entry.source === 'HKCU Run' && nameMatches(entry.name, preference.name))
}

/**
 * Disables one verified HKCU Run entry of an app and saves its previous value for restore.
 * The CLI commands and the launch menu share this. Returns a message describing the result.
 * When `expected` is given, the entry must still hold that command, so a confirmed plan never
 * removes a value other than the one it showed.
 */
export async function disableSignInEntry(
    paths: SystemPaths,
    backend: StartupBackend,
    app: AppId,
    entryName?: string,
    expected?: { readonly command: string; readonly valueKind: string }
): Promise<string> {
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
    if (expected && (expected.command !== entry.command || expected.valueKind !== entry.valueKind)) {
        throw new Error(`The startup entry ${entry.name} changed since the plan was shown. Run the workflow again.`)
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

async function forgetPreference(paths: SystemPaths, preference: StartupPreference): Promise<void> {
    const preferences = await readPreferences(paths)
    await savePreferences(
        paths,
        preferences.filter((item) => !(item.app === preference.app && nameMatches(item.name, preference.name)))
    )
}

function withRestorePending(preference: StartupPreference, restorePending: boolean): StartupPreference {
    return { ...preference, restorePending }
}

async function markRestorePending(paths: SystemPaths, preference: StartupPreference, restorePending: boolean): Promise<void> {
    const preferences = await readPreferences(paths)
    await savePreferences(
        paths,
        preferences.map((item) => (item.app === preference.app && nameMatches(item.name, preference.name) ? withRestorePending(item, restorePending) : item))
    )
}

/**
 * Restores the saved HKCU Run value of an app's entry and forgets its preference. When the app
 * has registered a value itself, restoring has nothing to write: the current value is kept and the
 * preference is forgotten. A restore that fails before writing leaves the preference ready to retry.
 */
export async function restoreSignInEntry(paths: SystemPaths, backend: StartupBackend, app: AppId, entryName?: string): Promise<string> {
    const preferences = await readPreferences(paths)
    const matches = preferences.filter((item) => item.app === app && (!entryName || nameMatches(item.name, entryName)))
    if (matches.length > 1) throw new Error(`Choose one startup entry by name: ${matches.map((item) => item.name).join(', ')}.`)
    const preference = matches[0]
    if (!preference) throw new Error(`No matching saved startup change for ${appNames[app]}. ${settingsGuide}`)
    if (isRegistered((await backend.inspect()).entries, preference)) {
        await forgetPreference(paths, preference)
        return `${preference.name} is already in HKCU Run. Kept its current value and forgot the saved preference.`
    }
    if (!preference.restorePending) await markRestorePending(paths, preference, true)
    try {
        await backend.changeRunValue(preference, true)
    } catch (error) {
        const registered = await backend.inspect().then(
            (snapshot) => isRegistered(snapshot.entries, preference),
            () => undefined
        )
        // Nothing was written, so do not leave the entry blocked as a restore in progress.
        if (registered === false) await markRestorePending(paths, preference, false)
        throw error
    }
    await forgetPreference(paths, preference)
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
