import type { SystemPaths } from '../../core/system-paths.ts'
import { type AppId, appIds, appNames, getAppInventory } from '../app-catalog.ts'
import { runPowerShell } from '../powershell.ts'
import { getScheduledStartupEntries, getStartupEntries } from './inventory.ts'
import { nameMatches, readPreferences } from './preferences.ts'

export const settingsGuide = 'Open Windows Settings > Apps > Startup (ms-settings:startupapps).'

export async function showStartup(paths: SystemPaths, app?: AppId): Promise<void> {
    const inventory = await getAppInventory(paths)
    const [startupInventory, scheduledInventory, saved] = await Promise.all([getStartupEntries(inventory), getScheduledStartupEntries(inventory), readPreferences(paths)])
    const entries = [...startupInventory.entries, ...scheduledInventory.entries]
    const warnings = [...startupInventory.warnings, ...scheduledInventory.warnings]
    for (const id of app ? [app] : appIds) {
        console.log(appNames[id])
        const installs = inventory.installs.filter((item) => item.id === id)
        const packages = inventory.packages.filter((item) => item.id === id)
        const startup = entries.filter((entry) => entry.app === id)
        const preferences = saved.filter((entry) => entry.app === id)
        for (const install of installs) console.log(`  ${install.type} · ${install.path}`)
        for (const item of packages) {
            console.log(`  ${item.fullName}${item.registered ? '' : ' (package files found; current-user registration unverified)'}`)
            for (const task of item.tasks) {
                console.log(`  ${task.label || task.name} [${task.name}] · packaged startup · current state in Windows Settings`)
            }
            if (item.tasks.length > 0) console.log(`  ${settingsGuide}`)
        }
        for (const entry of startup) {
            console.log(`  ${entry.name} · ${entry.source} · ${entry.state}${entry.supported ? ' · managed by CLI' : ''}\n    ${entry.target}`)
        }
        for (const pref of preferences) {
            const currentlyPresent = startup.some((entry) => entry.supported && nameMatches(entry.name, pref.name))
            const state = pref.restorePending ? 'restore pending' : currentlyPresent ? 'disable preference saved; entry is present' : 'disable preference saved; entry is absent'
            console.log(`  ${pref.name} · HKCU Run · ${state}`)
        }
        if (startup.length + preferences.length === 0 && !packages.some((item) => item.tasks.length)) {
            console.log('  No matching startup entries found in the inspected locations.')
        }
    }
    console.log('Windows services')
    const services = inventory.services.filter((service) => !app || service.id === app)
    for (const service of services) {
        console.log(`  ${appNames[service.id]} · ${service.name} · ${service.status} · ${service.start}`)
    }
    if (services.length === 0) console.log('  No verified app services found.')
    for (const warning of [...inventory.warnings, ...warnings]) console.warn(warning)
}

export async function openStartupSettings(): Promise<void> {
    await runPowerShell("Start-Process 'ms-settings:startupapps'")
}
