import type { SystemPaths } from '../core/system-paths.ts'
import { appNames } from '../windows/app-catalog.ts'
import type { StartupBackend } from '../windows/app-startup/backend.ts'
import type { StartupEntry } from '../windows/app-startup/inventory.ts'
import { disableSignInEntry, restoreSignInEntry } from '../windows/app-startup/manager.ts'
import { nameMatches, readPreferences, type StartupPreference } from '../windows/app-startup/preferences.ts'
import { settingsGuide } from '../windows/app-startup/status.ts'
import type { StartupChoice, StartupInspection, StartupNote, StartupProvider } from './types.ts'

const scope = 'Current user sign-in (HKCU Run)'

function isManageable(entry: StartupEntry): boolean {
    return entry.supported && entry.source === 'HKCU Run' && (entry.valueKind === 'String' || entry.valueKind === 'ExpandString')
}

function choiceId(action: 'disable' | 'restore', app: string, name: string): string {
    return `${action}:${app}:${name.toLowerCase()}`
}

function disableChoice(paths: SystemPaths, backend: StartupBackend, entry: StartupEntry): StartupChoice {
    const label = `${appNames[entry.app]} · ${entry.name}`
    return {
        id: choiceId('disable', entry.app, entry.name),
        label,
        hint: `${scope} · ${entry.target}`,
        planLines: [label, `  Removes the HKCU Run value and saves it for restore: ${entry.command}`],
        apply: () => disableSignInEntry(paths, backend, entry.app, entry.name)
    }
}

function restoreChoice(paths: SystemPaths, backend: StartupBackend, preference: StartupPreference, present: boolean): StartupChoice {
    const label = `${appNames[preference.app]} · ${preference.name}`
    const state = preference.restorePending ? 'Restore was interrupted; finish restoring it' : present ? 'The entry is already present' : 'Disabled by this tool'
    return {
        id: choiceId('restore', preference.app, preference.name),
        label,
        hint: `${scope} · ${state}`,
        planLines: [label, `  Writes the saved HKCU Run value back: ${preference.command}`],
        apply: () => restoreSignInEntry(paths, backend, preference.app, preference.name)
    }
}

function otherMechanisms(entries: readonly StartupEntry[], packagedApps: readonly string[], warnings: readonly string[]): StartupNote[] {
    const lines = [
        ...entries.filter((entry) => !isManageable(entry)).map((entry) => `${appNames[entry.app]} · ${entry.name} · ${entry.source} · ${entry.state}`),
        ...packagedApps.map((app) => `${app} has packaged startup tasks. ${settingsGuide}`),
        ...warnings
    ]
    return lines.length === 0 ? [] : [{ title: 'Other startup mechanisms (not changed here)', lines }]
}

/**
 * Current-user sign-in startup: the allowlisted apps' verified HKCU Run entries can be disabled,
 * and entries this tool saved earlier can be restored. Machine-wide Run values, RunOnce values,
 * Startup folders, scheduled tasks, and packaged startup tasks are reported but never changed.
 */
export function createSignInStartupProvider(paths: SystemPaths, backend: StartupBackend): StartupProvider {
    return {
        id: 'signin',
        async inspect(): Promise<StartupInspection> {
            const [snapshot, preferences] = await Promise.all([backend.inspect(), readPreferences(paths)])
            const disable = snapshot.entries
                .filter(isManageable)
                .filter((entry) => !preferences.some((preference) => preference.restorePending && nameMatches(preference.name, entry.name)))
                .map((entry) => disableChoice(paths, backend, entry))
            const restore = preferences.map((preference) =>
                restoreChoice(
                    paths,
                    backend,
                    preference,
                    snapshot.entries.some((entry) => isManageable(entry) && nameMatches(entry.name, preference.name))
                )
            )
            return {
                notes: otherMechanisms(
                    snapshot.entries,
                    snapshot.packagedApps.map((app) => appNames[app]),
                    snapshot.warnings
                ),
                groups: [
                    { id: 'disable', title: 'Turn off app startup at sign-in (current user)', message: 'Select app sign-in entries to turn off.', choices: disable },
                    { id: 'restore', title: 'Restore app startup at sign-in (current user)', message: 'Select saved sign-in entries to restore.', choices: restore }
                ]
            }
        }
    }
}
