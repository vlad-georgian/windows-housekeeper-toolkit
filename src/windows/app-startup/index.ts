import type { SystemPaths } from '../../core/system-paths.ts'
import { type AppId, appNames, getAppInventory } from '../app-catalog.ts'
import { getStartupEntries } from './inventory.ts'
import { type StartupPreference, nameMatches, readPreferences, savePreferences } from './preferences.ts'
import { changeRunValue } from './registry.ts'
import { settingsGuide } from './status.ts'

export { openStartupSettings, showStartup } from './status.ts'

export async function disableStartup(paths: SystemPaths, app: AppId, entryName?: string): Promise<void> {
    const inventory = await getAppInventory(paths)
    const { entries } = await getStartupEntries(inventory)
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
        const packaged = inventory.packages.some((item) => item.id === app && item.tasks.length > 0)
        throw new Error(`No matching manageable startup entry found for ${appNames[app]}.${packaged ? ` ${settingsGuide}` : ''}`)
    }
    if (saved?.restorePending) throw new Error(`Finish restoring ${saved.name} before disabling it again.`)
    if (!entry && saved) {
        const result = await changeRunValue(inventory, saved, false)
        console.log(`${saved.name} ${result === 'changed' ? 'was disabled again' : 'is already absent'}. The disable preference is saved.`)
        return
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
    await changeRunValue(inventory, preference, false)
    console.log(`Disabled ${preference.name} and saved its previous HKCU Run value.`)
}

export async function restoreStartup(paths: SystemPaths, app: AppId, entryName?: string): Promise<void> {
    const preferences = await readPreferences(paths)
    const matches = preferences.filter((item) => item.app === app && (!entryName || nameMatches(item.name, entryName)))
    if (matches.length > 1) throw new Error(`Choose one startup entry by name: ${matches.map((item) => item.name).join(', ')}.`)
    const preference = matches[0]
    if (!preference) throw new Error(`No matching saved startup change for ${appNames[app]}. ${settingsGuide}`)
    const inventory = await getAppInventory(paths)
    if (!preference.restorePending) {
        await savePreferences(
            paths,
            preferences.map((item) => (item === preference ? { ...item, restorePending: true } : item))
        )
    }
    await changeRunValue(inventory, preference, true)
    await savePreferences(
        paths,
        preferences.filter((item) => item !== preference)
    )
    console.log(`Restored the previous HKCU Run value for ${preference.name}.`)
}

export async function reapplyStartupPreferences(paths: SystemPaths): Promise<{ messages: string[]; failures: number }> {
    const preferences = (await readPreferences(paths)).filter((item) => !item.restorePending)
    if (preferences.length === 0) return { messages: [], failures: 0 }
    const inventory = await getAppInventory(paths)
    const messages: string[] = []
    let failures = 0
    for (const preference of preferences) {
        try {
            const result = await changeRunValue(inventory, preference, false)
            messages.push(`${appNames[preference.app]} startup · ${preference.name} · ${result === 'changed' ? 'disabled' : 'already absent'}`)
        } catch (error) {
            failures++
            messages.push(`${appNames[preference.app]} startup · ${preference.name} · ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return { messages, failures }
}
