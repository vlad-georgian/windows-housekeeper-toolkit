import { dirname, resolve } from 'node:path'

import { pathExists } from '../core/filesystem/index.ts'
import { isUnavailablePath, UnverifiedPathError } from '../core/filesystem/paths.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import { cancelled, type Cancelled, type LaunchOperation, type LaunchPrompts, type PlanSection } from '../launch/types.ts'
import type { DriveTypeLookup } from '../windows/drives.ts'
import { isAppRunning, type WindowsProcess } from '../windows/processes.ts'
import { type DirectoryIdentity, inspectDestinationPath, readDirectoryIdentity } from './directory-path.ts'
import { type AppInspection, inspectApp, moveSteps } from './inspect.ts'
import type { RecoveryJournal } from './journal.ts'
import { validateRelocationBase, type VolumeComparison } from './layout.ts'
import { IncompleteTransferError, linksTo, moveDirectory, restoreDirectory, type TransferResult } from './transfer.ts'
import { measureTree, UnsupportedTreeError } from './tree.ts'
import type { RelocatableApp } from './types.ts'

/** An outcome of applying, or previewing, one app's relocation. */
export type RelocationEvent =
    | { readonly kind: 'moved' | 'restored'; readonly appId: string; readonly original: string; readonly destination: string; readonly bytes: number }
    | { readonly kind: 'previewed'; readonly appId: string; readonly action: 'move' | 'restore' }
    | { readonly kind: 'skipped'; readonly appId: string; readonly reason: string }
    | {
          readonly kind: 'failed'
          readonly appId: string
          readonly action: 'move' | 'restore'
          readonly original: string
          readonly error: unknown
          readonly completed: readonly string[]
          readonly notAttempted: readonly string[]
      }

export interface RelocationOptions {
    readonly home: string
    readonly catalog: readonly RelocatableApp[]
    readonly journal: RecoveryJournal
    readonly dryRun: boolean
    readonly listProcesses: () => Promise<readonly WindowsProcess[]>
    readonly volumesDiffer: VolumeComparison
    readonly driveType: DriveTypeLookup
    readonly report: (event: RelocationEvent) => Promise<void>
}

interface PathTransfer {
    readonly original: string
    readonly destination: string
    readonly destinationDirectories: readonly DirectoryIdentity[]
    readonly retained?: true
}

/** One app's part of the plan: move its local paths under a base, or restore its linked paths. */
interface AppAction {
    readonly app: RelocatableApp
    readonly action: 'move' | 'restore'
    readonly base: string
    readonly transfers: readonly PathTransfer[]
}

/** An app's planned action and its plan lines, or why it is held back. */
type AppPlan = { readonly action: AppAction; readonly lines: readonly string[] } | { readonly blocked: string }

const title = 'Move apps to another drive'

async function planDestination(base: string, destination: string, action: 'move' | 'restore'): Promise<{ directories: readonly DirectoryIdentity[] } | { blocked: string }> {
    try {
        return { directories: await inspectDestinationPath(base, destination, action) }
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return { blocked: errorMessage(error) }
        throw error
    }
}

/** A tree's size for the plan, or why it cannot be relocated yet. */
async function sizeOf(path: string): Promise<{ size: string } | { blocked: string }> {
    try {
        return { size: formatBytes((await measureTree(path)).bytes) }
    } catch (error) {
        if (error instanceof UnsupportedTreeError) return { blocked: error.message.replace(/\.$/u, '') }
        throw error
    }
}

async function checklistHint(inspection: AppInspection): Promise<string> {
    if (inspection.migratedBase) return `On ${inspection.migratedBase}`
    if (inspection.restoreBase) return `Partially migrated to ${inspection.restoreBase}. Check to finish moving, or leave clear to restore.`
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
        const problem = await validateRelocationBase(base, { home: options.home, originals, volumesDiffer: options.volumesDiffer, driveType: options.driveType })
        if (problem === null) return resolve(base)
        prompts.log(problem)
    }
}

/** Plans a move, or returns why the app cannot move. Nothing changes on disk. */
async function planMove(inspection: AppInspection, base: string, home: string): Promise<AppPlan> {
    const lines = [`Move ${inspection.app.label} to another drive`]
    const transfers: PathTransfer[] = []
    const retained: PathTransfer[] = []
    for (const step of moveSteps(inspection, base, home)) {
        if (step.kind === 'blocked') return { blocked: step.reason }
        const destination = await planDestination(base, step.destination, step.kind === 'in-place' ? 'restore' : 'move')
        if ('blocked' in destination) return destination
        if (step.kind === 'in-place') {
            retained.push({ original: step.path, destination: step.destination, destinationDirectories: destination.directories, retained: true })
            lines.push(`  ${step.path} already links to ${step.destination}`)
            continue
        }
        if (await pathExists(step.destination)) return { blocked: `${step.destination} already exists. Move or remove it before relocating ${inspection.app.label}` }
        const size = await sizeOf(step.path)
        if ('blocked' in size) return size
        lines.push(`  ${step.path} → ${step.destination} (${size.size})`)
        transfers.push({ original: step.path, destination: step.destination, destinationDirectories: destination.directories })
    }
    return { action: { app: inspection.app, action: 'move', base, transfers: [...retained, ...transfers] }, lines }
}

/** Plans a restore, or returns why the app cannot be restored. Nothing changes on disk. */
async function planRestore(inspection: AppInspection, base: string): Promise<AppPlan> {
    const lines = [`Restore ${inspection.app.label} to its original paths`]
    const transfers: PathTransfer[] = []
    for (const entry of inspection.applicable) {
        if (entry.state.kind === 'local') continue
        if (entry.state.kind !== 'linked') return { blocked: `${entry.path} is not linked` }
        const destination = await planDestination(base, entry.state.target, 'restore')
        if ('blocked' in destination) return destination
        const size = await sizeOf(entry.state.target)
        if ('blocked' in size) return size
        lines.push(`  ${entry.state.target} → ${entry.path} (${size.size})`)
        transfers.push({ original: entry.path, destination: entry.state.target, destinationDirectories: destination.directories })
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
    if (isAppRunning(app.processGuardId, await options.listProcesses())) {
        const reason = `${app.label} is running. Close it and try again.`
        prompts.log(`${reason} Nothing was changed.`)
        await options.report({ kind: 'skipped', appId: app.id, reason })
        return
    }
    const transfer = action.action === 'move' ? moveDirectory : restoreDirectory
    const completed: string[] = []
    for (const [index, { original, destination, destinationDirectories, retained }] of action.transfers.entries()) {
        let result: TransferResult
        try {
            if (retained) {
                await inspectDestinationPath(action.base, destination, 'restore', destinationDirectories)
                await readDirectoryIdentity(dirname(original))
                if (!(await linksTo(original, destination))) throw new UnverifiedPathError(`${original} no longer links directly to ${destination}`)
                continue
            }
            result = await transfer({ appId: app.id, original, destination, base: action.base }, { journal: options.journal, destinationDirectories })
        } catch (error) {
            const notAttempted = action.transfers
                .slice(index + 1)
                .filter((entry) => !entry.retained)
                .map((entry) => entry.original)
            prompts.log(`${app.label}: ${errorMessage(error)}`)
            for (const path of completed) prompts.log(`Completed ${action.action} for ${path}.`)
            prompts.log(`Transfer stopped at ${original}.`)
            for (const path of notAttempted) prompts.log(`Did not attempt ${path}.`)
            if (completed.length > 0 && !(error instanceof IncompleteTransferError)) {
                prompts.log('Return to the relocation checklist to finish moving or restore the relocated paths after fixing the problem.')
            }
            await options.report({ kind: 'failed', appId: app.id, action: action.action, original, error, completed, notAttempted })
            return
        }
        completed.push(original)
        await options.report({ kind: action.action === 'move' ? 'moved' : 'restored', appId: app.id, original, destination, bytes: result.bytes })
    }
    prompts.log(action.action === 'move' ? `Moved ${app.label} to ${action.base}.` : `Restored ${app.label} to its original paths.`)
}

/**
 * The launch-menu operation for application relocation. Migrated applications start checked.
 * Checking an application moves its local paths, and leaving it clear restores its mirrored paths.
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
                prompts.log(
                    `An interrupted ${record.action} of ${record.original} needs attention (${record.phase}, record ${record.id}). Close the app and preserve the copies listed in ${options.journal.location}. See "Recovering an interrupted relocation" in the README.`
                )
            }
            const inspections: AppInspection[] = []
            for (const app of options.catalog) {
                if (held.has(app.id)) continue
                const inspection = await inspectApp(app, options.home, options)
                if ('blocked' in inspection) {
                    prompts.log(`${app.label} cannot be relocated. ${inspection.blocked}`)
                    continue
                }
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
                message: 'Select apps to keep on another drive. Migrated applications start checked. Leave an app clear to restore its relocated paths. Press A to toggle all.',
                options: checklistOptions,
                initialValues: inspections.filter((inspection) => inspection.migratedBase).map((inspection) => inspection.app.id)
            })
            if (chosen === null) return cancelled
            const toMove = inspections.filter((inspection) => chosen.includes(inspection.app.id) && !inspection.migratedBase)
            const toRestore = inspections.flatMap((inspection) =>
                inspection.restoreBase && !chosen.includes(inspection.app.id) ? [{ inspection, base: inspection.restoreBase }] : []
            )
            if (toMove.length === 0 && toRestore.length === 0) return null

            const actions: AppAction[] = []
            const lines: string[] = []
            if (toMove.length > 0) {
                const suggestion =
                    toMove.find((inspection) => inspection.restoreBase)?.restoreBase ?? inspections.find((inspection) => inspection.migratedBase)?.migratedBase ?? null
                const originals = toMove.flatMap((inspection) => inspection.applicable.filter((entry) => entry.state.kind === 'local').map((entry) => entry.path))
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
            for (const { inspection, base } of toRestore) {
                const plan = await planRestore(inspection, base)
                if ('blocked' in plan) {
                    prompts.log(`${inspection.app.label} cannot be restored: ${plan.blocked}.`)
                    continue
                }
                actions.push(plan.action)
                lines.push(...plan.lines)
            }
            if (actions.length === 0) return null

            const processes = await options.listProcesses()
            for (const action of actions) {
                if (isAppRunning(action.app.processGuardId, processes)) lines.push(`${action.app.label} is running. Close it before applying, or it will be skipped.`)
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
