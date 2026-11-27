import type { CleanupSummary } from '../cleanup/summary.ts'
import type { AuditLogger } from '../core/audit-logger.ts'
import { errorMessage } from '../core/format.ts'
import { cancelled, type LaunchOperation, type LaunchPrompts, type PlanSection } from '../launch/types.ts'
import type { StartupChoice, StartupGroup, StartupProvider } from './types.ts'

/** The parts of a run's shared state that startup changes report into. */
export interface StartupSession {
    readonly audit: AuditLogger
    readonly summary: CleanupSummary
    readonly dryRun: boolean
}

interface ChosenGroup {
    readonly group: StartupGroup
    readonly choices: readonly StartupChoice[]
}

/**
 * The "Manage automatic startup" launch menu operation. It inspects every provider, shows what
 * it will not change, asks one unchecked checklist per group, and plans the selected changes.
 * Nothing changes until the combined plan is confirmed. A failed change is recorded and the
 * remaining changes still run.
 */
export function createStartupOperation(providers: readonly StartupProvider[], session: StartupSession): LaunchOperation {
    return {
        id: 'startup',
        label: 'Manage automatic startup',
        async gather(prompts: LaunchPrompts): Promise<PlanSection | null | typeof cancelled> {
            prompts.log('Inspecting app startup entries…')
            const inspections = await Promise.all(providers.map((provider) => provider.inspect()))
            for (const note of inspections.flatMap((inspection) => inspection.notes)) prompts.note(note.title, note.lines)

            const groups = inspections.flatMap((inspection) => inspection.groups).filter((group) => group.choices.length > 0)
            if (groups.length === 0) prompts.log('No app startup entries can be changed.')

            const chosen: ChosenGroup[] = []
            for (const group of groups) {
                const answer = await prompts.checklist({
                    message: `${group.message} Press A to toggle all.`,
                    options: group.choices.map((choice) => ({
                        value: choice.id,
                        label: choice.label,
                        ...(choice.hint === undefined ? {} : { hint: choice.hint })
                    })),
                    initialValues: []
                })
                if (answer === null) return cancelled
                const choices = group.choices.filter((choice) => answer.includes(choice.id))
                if (choices.length > 0) chosen.push({ group, choices })
            }
            if (chosen.length === 0) return null

            return {
                title: 'Manage automatic startup',
                lines: chosen.flatMap(({ group, choices }) => [group.title, ...choices.flatMap((choice) => choice.planLines.map((line) => `  ${line}`))]),
                async apply() {
                    for (const choice of chosen.flatMap((entry) => entry.choices)) {
                        if (session.dryRun) {
                            prompts.log(`Dry run: ${choice.label} was not changed.`)
                            continue
                        }
                        try {
                            prompts.log(await choice.apply())
                        } catch (error) {
                            session.summary.failures++
                            session.summary.failedApps.add('startup')
                            prompts.log(`Could not change ${choice.label}: ${errorMessage(error)}`)
                            await session.audit.recordError('startup', choice.label, null, error)
                        }
                    }
                }
            }
        }
    }
}
