import type { AppId } from '../windows/app-catalog.ts'
import type { StartupBackend, StartupSnapshot } from '../windows/app-startup/backend.ts'
import type { StartupEntry } from '../windows/app-startup/inventory.ts'
import type { StartupPreference } from '../windows/app-startup/preferences.ts'

/** An HKCU Run entry that the CLI can manage. */
export function runEntry(app: AppId, name: string, executable: string): StartupEntry {
    return {
        app,
        name,
        source: 'HKCU Run',
        state: 'registered; see Startup Apps for approval',
        target: executable,
        command: `"${executable}" --hidden`,
        valueKind: 'String',
        supported: true
    }
}

/** An entry in another startup mechanism, which the CLI only reports. */
export function otherEntry(app: AppId, name: string, source: string, executable: string): StartupEntry {
    return { app, name, source, state: 'registered', target: executable, command: '', valueKind: '', supported: false }
}

/**
 * An in-memory HKCU Run key. It applies the same rules as the real registry backend: removing
 * an absent value or restoring a present one is `unchanged`, and a different command is refused.
 */
export class FakeStartupBackend implements StartupBackend {
    /** Every change made, in order, such as `disable Codex`. */
    readonly changes: string[] = []
    /** Lower-case entry names whose change is refused. */
    readonly failing = new Set<string>()
    private readonly values = new Map<string, StartupEntry>()

    constructor(
        runEntries: readonly StartupEntry[] = [],
        private readonly others: readonly StartupEntry[] = [],
        private readonly packagedApps: readonly AppId[] = [],
        private readonly warnings: readonly string[] = []
    ) {
        for (const entry of runEntries) this.values.set(entry.name.toLowerCase(), entry)
    }

    /** Puts a value in the fake HKCU Run key, as an app re-registering itself would. */
    register(entry: StartupEntry): void {
        this.values.set(entry.name.toLowerCase(), entry)
    }

    /** The command currently stored in the fake HKCU Run key, or undefined when absent. */
    runValue(name: string): string | undefined {
        return this.values.get(name.toLowerCase())?.command
    }

    inspect(): Promise<StartupSnapshot> {
        return Promise.resolve({ entries: [...this.values.values(), ...this.others], warnings: this.warnings, packagedApps: this.packagedApps })
    }

    changeRunValue(preference: StartupPreference, restore: boolean): Promise<'changed' | 'unchanged'> {
        const key = preference.name.toLowerCase()
        if (this.failing.has(key)) return Promise.reject(new Error(`Simulated failure for ${preference.name}.`))
        const current = this.values.get(key)
        if (current && current.command !== preference.command) {
            return Promise.reject(new Error('A different command now uses this HKCU Run value.'))
        }
        if (restore === (current !== undefined)) return Promise.resolve('unchanged')
        this.changes.push(`${restore ? 'restore' : 'disable'} ${preference.name}`)
        if (restore) {
            this.values.set(key, {
                app: preference.app,
                name: preference.name,
                source: 'HKCU Run',
                state: 'registered; see Startup Apps for approval',
                target: preference.target,
                command: preference.command,
                valueKind: preference.valueKind,
                supported: true
            })
        } else {
            this.values.delete(key)
        }
        return Promise.resolve('changed')
    }
}
