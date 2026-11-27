import { withServiceStartupLock } from '../core/state.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import { appNames } from '../windows/app-catalog.ts'
import { isAutomatic, sameService, ServiceChangeRejectedError, type AppService, type ServiceBackend } from '../windows/app-services/backend.ts'
import { readServicePreferences, saveServicePreferences, type ServicePreference } from '../windows/app-services/preferences.ts'
import type { StartupChoice, StartupProvider } from './types.ts'

const scope = 'Machine-wide Windows services (administrator elevation required)'

function serviceLabel(service: AppService): string {
    return `${appNames[service.app]} · ${service.name}`
}

function serviceChoice(action: 'disable' | 'restore', service: AppService, target: AppService['mode'], apply: () => Promise<string>): StartupChoice {
    const label = serviceLabel(service)
    return {
        id: `${action}:${service.name.toLowerCase()}`,
        label,
        hint: `${scope} · ${service.mode} → ${target}`,
        planLines: [
            `${label} · ${service.mode} → ${target}`,
            `  ${service.imagePath}`,
            target === service.mode ? '  Verifies the restored mode and clears the saved preference.' : '  Changes startup configuration only. A running service keeps running.'
        ],
        apply
    }
}

export function createServiceStartupProvider(paths: SystemPaths, backend: ServiceBackend): StartupProvider {
    return {
        id: 'services',
        async inspect() {
            const snapshot = await backend.inspect()
            if (!snapshot.elevated) {
                return { groups: [], notes: [{ title: scope, lines: ['Open an elevated terminal to manage app service startup.'] }] }
            }

            const preferences = await readServicePreferences(paths)
            const warnings = [...snapshot.warnings]
            const disable: StartupChoice[] = []
            const restore: StartupChoice[] = []

            for (const service of snapshot.services) {
                if (!isAutomatic(service.mode) || preferences.some((preference) => preference.service.name === service.name)) continue
                const saved: ServicePreference = { service: { ...service, mode: service.mode }, restorePending: false }
                disable.push(
                    serviceChoice('disable', service, 'Manual', () =>
                        withServiceStartupLock(async () => {
                            const current = await backend.inspect()
                            if (!current.elevated || !current.services.some((entry) => sameService(entry, service) && entry.mode === service.mode)) {
                                throw new Error(`${service.name} changed since the plan was shown or cannot be verified.`)
                            }
                            const latest = await readServicePreferences(paths)
                            if (latest.some((preference) => preference.service.name === service.name)) throw new Error(`${service.name} already has a saved preference.`)
                            await saveServicePreferences(paths, [...latest, saved])
                            try {
                                await backend.changeMode(service, 'Manual')
                            } catch (error) {
                                // Only a confirmed pre-write rejection can undo this attempt's saved record.
                                if (error instanceof ServiceChangeRejectedError) await saveServicePreferences(paths, latest)
                                throw error
                            }
                            return `Changed ${service.name} from ${service.mode} to Manual and saved its prior startup mode.`
                        })
                    )
                )
            }

            for (const preference of preferences) {
                const saved = preference.service
                const current = snapshot.services.find((service) => sameService(service, saved))
                // Restoring can require separate SCM calls for Automatic and its delayed-start flag.
                const interruptedRestore = preference.restorePending && isAutomatic(current?.mode)
                if (!current || (current.mode !== 'Manual' && current.mode !== saved.mode && !interruptedRestore)) {
                    warnings.push(`Could not offer restore for ${saved.name}. The saved service identity or expected startup mode no longer matches.`)
                    continue
                }
                restore.push(
                    serviceChoice('restore', current, saved.mode, () =>
                        withServiceStartupLock(async () => {
                            const latest = await readServicePreferences(paths)
                            const record = latest.find(
                                (item) => sameService(item.service, saved) && item.service.mode === saved.mode && item.restorePending === preference.restorePending
                            )
                            if (!record) throw new Error(`The saved preference for ${saved.name} changed. Run the workflow again.`)
                            const service = await backend.inspect()
                            if (!service.elevated || !service.services.some((entry) => sameService(entry, current) && entry.mode === current.mode)) {
                                throw new Error(`${saved.name} changed since the plan was shown or cannot be verified.`)
                            }
                            if (current.mode === 'Manual' && !record.restorePending) {
                                await saveServicePreferences(
                                    paths,
                                    latest.map((item) => (item === record ? { ...item, restorePending: true } : item))
                                )
                            }
                            await backend.changeMode(current, saved.mode)
                            await saveServicePreferences(
                                paths,
                                latest.filter((item) => item !== record)
                            )
                            return current.mode === saved.mode
                                ? `Verified ${saved.name} is already ${saved.mode} and cleared its saved preference.`
                                : `Restored ${saved.name} to ${saved.mode}.`
                        })
                    )
                )
            }

            return {
                notes: warnings.length ? [{ title: scope, lines: warnings }] : [],
                groups: [
                    {
                        id: 'disable-services',
                        title: `Turn off automatic startup · ${scope}`,
                        message: `Select automatic app services to change to Manual. ${scope}.`,
                        choices: disable
                    },
                    { id: 'restore-services', title: `Restore startup modes · ${scope}`, message: `Select saved app service startup modes to restore. ${scope}.`, choices: restore }
                ]
            }
        }
    }
}
