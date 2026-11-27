import { resolve } from 'node:path'

import { pathExists } from '../core/filesystem/index.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import { cancelled, type Cancelled, type LaunchOperation, type LaunchPrompts, type PlanSection } from '../launch/types.ts'
import { isAppRunning, type WindowsProcess } from '../windows/processes.ts'
import { type AppInspection, inspectApp, moveSteps } from './inspect.ts'
import type { RecoveryJournal } from './journal.ts'
import { validateRelocationBase, type VolumeComparison } from './layout.ts'
import { moveDirectory, restoreDirectory } from './transfer.ts'
import { measureTree, UnsupportedTreeError } from './tree.ts'
import type { RelocatableApp } from './types.ts'

/** An outcome of applying, or previewing, one app's relocation. */
export type RelocationEvent =
    | { readonly kind: 'moved' | 'restored'; readonly appId: string; readonly original: string; readonly destination: string; readonly bytes: number }
    | { readonly kind: 'previewed'; readonly appId: string; readonly action: 'move' | 'restore' }
    | { readonly kind: 'skipped'; readonly appId: string; readonly reason: string }
    | { readonly kind: 'failed'; readonly appId: string; readonly original: string; readonly error: unknown }

export interface RelocationOptions {
    readonly home: string
    readonly catalog: readonly RelocatableApp[]
    readonly journal: RecoveryJournal
    readonly dryRun: boolean
    readonly listProcesses: () => Promise<readonly WindowsProcess[]>
    readonly volumesDiffer: VolumeComparison
    readonly report: (event: RelocationEvent) => Promise<void>
}

interface PathTransfer {
    readonly original: string
    readonly destination: string
}

/** One app's part of the plan: move its local paths under a base, or restore all of them. */
interface AppAction {
    readonly app: RelocatableApp
    readonly action: 'move' | 'restore'
    readonly base: string
    readonly transfers: readonly PathTransfer[]
}

const title = 'Move apps to another drive'

async function describeSize(path: string): Promise<string> {
    const { bytes } = await measureTree(path)
    return formatBytes(bytes)
}

async function checklistHint(inspection: AppInspection): Promise<string> {
    if (inspection.migratedBase) return `On ${inspection.migratedBase}`
    const local = inspection.applicable.filter((entry) => entry.state.kind === 'local')
    let bytes = 0
    for (const entry of local) {
        try {
            bytes += (await measureTree(entry.path)).bytes
        } catch (error) {
            if (!(error instanceof UnsupportedTreeError)) throw error
            return 'Contains links that cannot be moved yet'
        }
    }
    const linked = inspection.applicable.length - local.length
    return `${formatBytes(bytes)} local${linked > 0 ? `, ${linked} path(s) already linked` : ''}`
}

async function askForBase(prompts: LaunchPrompts, options: RelocationOptions, originals: readonly string[], suggestion: string | null): Promise<string | Cancelled> {
    for (;;) {
        const answer = await prompts.text({
            message: 'Base directory on another drive for the selected apps',
            placeholder: 'E:\\Software',
            ...(suggestion === null ? {} : { initialValue: suggestion })
        })
        if (answer === null) return cancelled
        const base = answer.trim()
        const problem = await validateRelocationBase(base, { home: options.home, originals, volumesDiffer: options.volumesDiffer })
        if (problem === null) return resolve(base)
        prompts.log(problem)
    }
}

/** Plans a move, or returns why the app cannot move. Nothing changes on disk. */
async function planMove(inspection: AppInspection, base: string, home: string): Promise<{ action: AppAction; lines: string[] } | { blocked: string }> {
    const lines = [`Move ${inspection.app.label} to another drive`]
    const transfers: PathTransfer[] = []
    for (const step of moveSteps(inspection, base, home)) {
        if (step.kind === 'blocked') return { blocked: step.reason }
        if (step.kind === 'in-place') {
            lines.push(`  ${step.path} already links to ${step.destination}`)
            continue
        }
        if (await pathExists(step.destination)) return { blocked: `${step.destination} already exists. Move or remove it before relocating ${inspection.app.label}` }
        try {
            lines.push(`  ${step.path} → ${step.destination} (${await describeSize(step.path)})`)
        } catch (error) {
            if (error instanceof UnsupportedTreeError) return { blocked: error.message }
            throw error
        }
        transfers.push({ original: step.path, destination: step.destination })
    }
    return { action: { app: inspection.app, action: 'move', base, transfers }, lines }
}

async function planRestore(inspection: AppInspection, base: string): Promise<{ action: AppAction; lines: string[] }> {
    const lines = [`Restore ${inspection.app.label} to its original paths`]
    const transfers: PathTransfer[] = []
    for (const entry of inspection.applicable) {
        if (entry.state.kind !== 'linked') throw new Error(`${entry.path} is not linked.`)
        lines.push(`  ${entry.state.target} → ${entry.path} (${await describeSize(entry.state.target)})`)
        transfers.push({ original: entry.path, destination: entry.state.target })
    }
    return { action: { app: inspection.app, action: 'restore', base, transfers }, lines }
}

async function applyAction(action: AppAction, prompts: LaunchPrompts, options: RelocationOptions): Promise<void> {
    const { app } = action
    if (options.dryRun) {
        prompts.log(`Dry run: ${app.label} would ${action.action === 'move' ? `move to ${action.base}` : 'be restored to its original paths'}.`)
        await options.report({ kind: 'previewed', appId: app.id, action: action.action })
        return
    }
    if (isAppRunning(app.appId, await options.listProcesses())) {
        const reason = `${app.label} is running. Close it and try again.`
        prompts.log(`${reason} Nothing was changed.`)
        await options.report({ kind: 'skipped', appId: app.id, reason })
        return
    }
    const transfer = action.action === 'move' ? moveDirectory : restoreDirectory
    for (const { original, destination } of action.transfers) {
        try {
            const result = await transfer({ appId: app.id, original, destination, base: action.base }, { journal: options.journal })
            await options.report({ kind: action.action === 'move' ? 'moved' : 'restored', appId: app.id, original, destination, bytes: result.bytes })
        } catch (error) {
            prompts.log(`${app.label}: ${errorMessage(error)}`)
            await options.report({ kind: 'failed', appId: app.id, original, error })
            return
        }
    }
    prompts.log(action.action === 'move' ? `Moved ${app.label} to ${action.base}.` : `Restored ${app.label} to its original paths.`)
}

/**
 * The launch-menu operation for application relocation. Migrated apps start checked; checking
 * another app moves it under a base on another drive, and clearing a migrated app restores it.
 */
export function createRelocationOperation(options: RelocationOptions): LaunchOperation {
    return {
        id: 'relocation',
        label: title,
        hint: 'Keep apps usable at their original paths through junctions',
        async gather(prompts): Promise<PlanSection | null | Cancelled> {
            const held = new Set<string>()
            for (const record of await options.journal.list()) {
                held.add(record.appId)
                prompts.log(`An interrupted ${record.action} of ${record.original} needs attention. Recovery details are in ${options.journal.location}.`)
            }
            const inspections: AppInspection[] = []
            for (const app of options.catalog) {
                if (held.has(app.id)) continue
                const inspection = await inspectApp(app, options.home)
                if (inspection.applicable.length > 0) inspections.push(inspection)
            }
            if (inspections.length === 0) {
                prompts.log(`${title}: no supported apps were found.`)
                return null
            }

            const checklistOptions = []
            for (const inspection of inspections) {
                checklistOptions.push({ value: inspection.app.id, label: inspection.app.label, hint: await checklistHint(inspection) })
            }
            const chosen = await prompts.checklist({
                message: 'Select apps to keep on another drive. Moved apps start checked; clear one to restore it. Press A to toggle all.',
                options: checklistOptions,
                initialValues: inspections.filter((inspection) => inspection.migratedBase).map((inspection) => inspection.app.id)
            })
            if (chosen === null) return cancelled
            const toMove = inspections.filter((inspection) => chosen.includes(inspection.app.id) && !inspection.migratedBase)
            const toRestore = inspections.filter((inspection) => !chosen.includes(inspection.app.id) && inspection.migratedBase)
            if (toMove.length === 0 && toRestore.length === 0) return null

            const actions: AppAction[] = []
            const lines: string[] = []
            if (toMove.length > 0) {
                const suggestion = inspections.find((inspection) => inspection.migratedBase)?.migratedBase ?? null
                const originals = toMove.flatMap((inspection) => inspection.applicable.map((entry) => entry.path))
                const base = await askForBase(prompts, options, originals, suggestion)
                if (base === cancelled) return cancelled
                for (const inspection of toMove) {
                    const plan = await planMove(inspection, base, options.home)
                    if ('blocked' in plan) {
                        prompts.log(`${inspection.app.label} cannot move: ${plan.blocked}.`)
                        continue
                    }
                    actions.push(plan.action)
                    lines.push(...plan.lines)
                }
            }
            for (const inspection of toRestore) {
                const plan = await planRestore(inspection, inspection.migratedBase ?? '')
                actions.push(plan.action)
                lines.push(...plan.lines)
            }
            if (actions.length === 0) return null

            const processes = await options.listProcesses()
            for (const action of actions) {
                if (isAppRunning(action.app.appId, processes)) lines.push(`${action.app.label} is running. Close it before applying, or it will be skipped.`)
            }
            return {
                title,
                lines,
                async apply() {
                    for (const action of actions) await applyAction(action, prompts, options)
                }
            }
        }
    }
}
