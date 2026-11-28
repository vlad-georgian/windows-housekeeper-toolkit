import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { pathExists } from '../core/filesystem/index.ts'
import { canonicalPathKey, isPathInside, isUnavailablePath, UnverifiedPathError } from '../core/filesystem/paths.ts'
import { errorMessage, formatBytes } from '../core/format.ts'
import { cancelled, type Cancelled, type LaunchOperation, type LaunchPrompts, type PlanSection } from '../launch/types.ts'
import type { DriveTypeLookup } from '../windows/drives.ts'
import { isAppRunning, type WindowsProcess } from '../windows/processes.ts'
import { type DirectoryIdentity, inspectDestinationPath, readDirectoryIdentity } from './directory-path.ts'
import { type AppInspection, claimRelocationPaths, type OriginalLink, inspectApp, inspectPath, moveSteps, recordedMirror } from './inspect.ts'
import type { MirrorOwner, RecoveryJournal } from './journal.ts'
import { relocationBaseOf, validateRelocationBase, type VolumeComparison } from './layout.ts'
import { IncompleteTransferError, linksTo, moveDirectory, restoreDirectory, type TransferResult } from './transfer.ts'
import { type CopiedFiles, externalHardLinks, measureTree, UnsupportedTreeError } from './tree.ts'
import type { RelocatableApp, RelocationPath } from './types.ts'

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
    readonly expectedIdentity: string
    readonly kind: 'directory' | 'file'
    readonly originalLink?: OriginalLink
    readonly forwarding?: OriginalLink
    readonly nativeDependency?: boolean
    readonly retained?: true
    /** Restore on the strength of the toolkit's receipt, because the app's ownership evidence is gone. */
    readonly recordedOnly?: true
    readonly linkTargets?: ReadonlyMap<string, { from: string; to: string }>
    readonly original: string
    readonly destination: string
    readonly destinationDirectories: readonly DirectoryIdentity[]
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

async function planSelector(inspection: AppInspection, original: string, physical: string): Promise<PathTransfer['linkTargets']> {
    const rule = inspection.applicable.find((entry) => entry.path === original)?.linkedSelector
    if (!rule) return undefined
    const owner = inspection.applicable.find((entry) => entry.path === rule.owner)
    if (!owner || (owner.state.kind !== 'local' && owner.state.kind !== 'linked')) return undefined
    const link = join(physical, rule.entry)
    const from = join(owner.state.kind === 'linked' ? owner.state.target : owner.path, rule.selector)
    const to = join(owner.path, rule.selector)
    if (canonicalPathKey(from) === canonicalPathKey(to)) return undefined
    try {
        const target = resolve(dirname(link), await readlink(link))
        if (canonicalPathKey(target) !== canonicalPathKey(from)) return undefined
        if (canonicalPathKey(await realpath(from)) !== canonicalPathKey(await realpath(to))) return undefined
        return new Map([[canonicalPathKey(link), { from, to }]])
    } catch (error) {
        if (isUnavailablePath(error) || (error instanceof Error && 'code' in error && error.code === 'EINVAL')) return undefined
        throw error
    }
}

async function planDestination(base: string, destination: string, action: 'move' | 'restore'): Promise<{ directories: readonly DirectoryIdentity[] } | { blocked: string }> {
    try {
        return { directories: await inspectDestinationPath(base, destination, action) }
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return { blocked: errorMessage(error) }
        throw error
    }
}

/** A tree's size for the plan, or why it cannot be relocated yet. */
async function sizeOf(path: string, seen: Set<string>): Promise<{ size: string } | { blocked: string }> {
    try {
        return { size: formatBytes((await measureTree(path, seen)).bytes) }
    } catch (error) {
        if (error instanceof UnsupportedTreeError) return { blocked: error.message.replace(/\.$/u, '') }
        throw error
    }
}

async function checklistHint(inspection: AppInspection): Promise<string> {
    const unverified = inspection.applicable.find((entry) => entry.unverifiedOwnership)
    if (unverified) return `${unverified.path} no longer shows ${inspection.app.label} data. Leave clear to restore it.`
    if (inspection.migratedBase) return `On ${inspection.migratedBase}`
    if (inspection.restoreBase) return `Partially migrated to ${inspection.restoreBase}. Check to finish moving, or leave clear to restore.`
    const seen = new Set<string>()
    const local = inspection.applicable.filter((entry) => entry.state.kind === 'local')
    let bytes = 0
    for (const entry of local) {
        try {
            bytes += (await measureTree(entry.path, seen)).bytes
        } catch (error) {
            if (!(error instanceof UnsupportedTreeError)) throw error
            return 'Contains links that cannot be moved yet'
        }
    }
    const linked = inspection.applicable.length - local.length
    return `${formatBytes(bytes)} local${linked > 0 ? `, ${linked} path(s) already linked` : ''}`
}

function startedBefore(parent: WindowsProcess, child: WindowsProcess): boolean {
    const parentStarted = Date.parse(parent.createdAt ?? '')
    const childStarted = Date.parse(child.createdAt ?? '')
    return Number.isFinite(parentStarted) && Number.isFinite(childStarted) && parentStarted <= childStarted
}

/**
 * The toolkit's own process and the launcher wrappers that started it, such as `vp run start`
 * and `bun run`. The chain ends at the first ancestor that is not a launcher, or that did not
 * start before its child, because Windows reuses the ID of a parent that has exited. Without
 * parent IDs and start times, only the toolkit itself is exempt.
 */
export function toolkitProcessIds(processes: readonly WindowsProcess[], self = process.pid): ReadonlySet<number> {
    const byId = new Map(processes.map((entry) => [entry.id, entry]))
    const own = new Set([self])
    for (let current = byId.get(self); typeof current?.parentId === 'number' && !own.has(current.parentId);) {
        const parent = byId.get(current.parentId)
        if (!parent || !/^(vp|vpr|bun|node)\.exe$/iu.test(parent.name) || !startedBefore(parent, current)) break
        own.add(parent.id)
        current = parent
    }
    return own
}

function isActionRunning(action: AppAction, processes: readonly WindowsProcess[]): boolean {
    const own = toolkitProcessIds(processes)
    // The toolkit's launcher chain matches the Bun and Vite+ name guards. The path checks below
    // still guard a launcher that runs from inside a moved tree.
    if (
        isAppRunning(
            action.app.processGuardId,
            processes.filter((entry) => !own.has(entry.id))
        )
    )
        return true
    const directories = action.transfers.flatMap((entry) => {
        if (entry.kind === 'file') return []
        return [entry.original, entry.destination, ...(entry.originalLink ? [entry.originalLink.target] : [])]
    })
    return processes.some(
        (processInfo) =>
            processInfo.id !== process.pid &&
            directories.some((directory) => {
                if (processInfo.path && isPathInside(processInfo.path, directory)) return true
                const command = processInfo.commandLine?.replaceAll('/', '\\').toLowerCase()
                return command?.includes(`${canonicalPathKey(directory)}\\`) ?? false
            })
    )
}

/**
 * Hard-link names outside the transferred trees, under each path's policy. A copy on another
 * drive cannot keep those names linked, so a refusing path blocks the action.
 */
async function hardLinkPlan(app: RelocatableApp, transfers: readonly PathTransfer[]): Promise<{ readonly lines: readonly string[] } | { readonly blocked: string }> {
    const moving = transfers
        .filter((entry) => !entry.retained && entry.kind === 'directory')
        .map((entry) => ({ entry, policy: app.paths.find((path) => path.path === entry.original)?.hardLinks, physical: entry.originalLink?.target ?? entry.original }))
    if (!moving.some(({ policy }) => policy)) return { lines: [] }
    let external
    try {
        external = await externalHardLinks(moving.map(({ physical }) => physical))
    } catch (error) {
        if (error instanceof UnsupportedTreeError) return { blocked: error.message.replace(/\.$/u, '') }
        throw error
    }
    for (const { entry, policy, physical } of moving) {
        const files = external.filter((file) => file.roots.includes(physical))
        if (policy === 'refuse-external' && files[0]) {
            return {
                blocked: `${files[0].path} is hard-linked to a name outside ${entry.original}, as Scoop does for persisted files. ${files.length} file(s) would lose that link on another drive`
            }
        }
    }
    const reported = external.filter((file) => moving.some(({ policy, physical }) => policy === 'report-external' && file.roots.includes(physical)))
    if (reported.length === 0) return { lines: [] }
    const bytes = reported.reduce((total, file) => total + file.bytes, 0)
    return {
        lines: [`    ${reported.length} hard-linked file(s) (${formatBytes(bytes)}) also have names outside these paths. Those names keep their own copies where they are.`]
    }
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
async function planMove(inspection: AppInspection, base: string, home: string, journal: RecoveryJournal): Promise<AppPlan> {
    const lines = [`Move ${inspection.app.label} to another drive`]
    const seen = new Set<string>()
    const transfers: PathTransfer[] = []
    const retained: PathTransfer[] = []
    const steps = moveSteps(inspection, base, home)
    const dependencies = steps.filter((step) => step.kind === 'move' && step.nativeDependency)
    for (const step of [...dependencies, ...steps.filter((candidate) => !(candidate.kind === 'move' && candidate.nativeDependency))]) {
        if (step.kind === 'blocked') return { blocked: step.reason }
        if (step.kind === 'move' && inspection.applicable.find((entry) => entry.path === step.path)?.unverifiedOwnership) {
            return { blocked: `${step.path} no longer shows ${inspection.app.label} data. Leave it clear to restore it instead` }
        }
        const destination = await planDestination(base, step.destination, step.kind === 'in-place' && !step.file ? 'restore' : 'move')
        if ('blocked' in destination) return destination
        if (step.kind === 'in-place') {
            retained.push({
                original: step.path,
                destination: step.destination,
                destinationDirectories: destination.directories,
                originalLink: step.originalLink,
                expectedIdentity: step.originalLink.identity,
                kind: step.file ? 'file' : 'directory',
                retained: true
            })
            lines.push(`  ${step.path} already links to ${step.destination}`)
            continue
        }
        let forwarding: OriginalLink | undefined
        if (await pathExists(step.destination)) {
            const receipt = await journal.owner(step.path)
            if (receipt?.forwarding && canonicalPathKey(receipt.path) === canonicalPathKey(step.destination)) {
                const state = await inspectPath(step.destination, step.file ? 'file' : 'directory')
                if (state.kind === 'linked' && state.identity === receipt.identity && canonicalPathKey(state.target) === canonicalPathKey(step.path)) forwarding = state
            }
            if (!forwarding) return { blocked: `${step.destination} already exists. Move or remove it before relocating ${inspection.app.label}` }
        }
        const size = await sizeOf(step.originalLink?.target ?? step.path, seen)
        if ('blocked' in size) return size
        lines.push(`  ${step.path}${step.originalLink ? ` (linked to ${step.originalLink.target})` : ''} → ${step.destination} (${size.size})`)
        if (step.originalLink) {
            const owner = await journal.owner(step.path)
            lines.push(
                owner?.identity === step.originalLink.targetIdentity && owner.path === step.originalLink.target
                    ? `    Keep ${step.originalLink.target} usable through a forwarding link.`
                    : `    Keep the existing backing store at ${step.originalLink.target}.`
            )
        }
        const linkTargets = await planSelector(inspection, step.path, step.originalLink?.target ?? step.path)
        transfers.push({
            ...(linkTargets && { linkTargets }),
            ...(forwarding && { forwarding }),
            destinationDirectories: destination.directories,
            original: step.path,
            destination: step.destination,
            kind: step.file ? 'file' : 'directory',
            expectedIdentity: step.identity,
            ...(step.originalLink && { originalLink: step.originalLink }),
            ...(step.nativeDependency && { nativeDependency: true })
        })
    }
    const links = await hardLinkPlan(inspection.app, transfers)
    if ('blocked' in links) return links
    return { action: { app: inspection.app, action: 'move', base, transfers: [...retained, ...transfers] }, lines: [...lines, ...links.lines] }
}

/** Plans a restore, or returns why the app cannot be restored. Nothing changes on disk. */
async function planRestore(inspection: AppInspection, base: string, journal: RecoveryJournal): Promise<AppPlan> {
    const lines = [`Restore ${inspection.app.label} to its original paths`]
    const seen = new Set<string>()
    const transfers: PathTransfer[] = []
    for (const entry of inspection.applicable) {
        if (entry.state.kind === 'local') continue
        if (entry.state.kind !== 'linked') return { blocked: `${entry.path} is not linked` }
        const destination = await planDestination(base, entry.state.target, entry.kind === 'file' ? 'move' : 'restore')
        if ('blocked' in destination) return destination
        const size = await sizeOf(entry.state.target, seen)
        if ('blocked' in size) return size
        lines.push(`  ${entry.state.target} → ${entry.path} (${size.size})`)
        const owner = await journal.owner(entry.path)
        if (owner?.identity !== entry.state.targetIdentity || owner.path !== entry.state.target) lines.push(`    Keep the existing backing store at ${entry.state.target}.`)
        const linkTargets = await planSelector(inspection, entry.path, entry.state.target)
        transfers.push({
            ...(linkTargets && { linkTargets }),
            destinationDirectories: destination.directories,
            original: entry.path,
            destination: entry.state.target,
            kind: entry.kind ?? 'directory',
            expectedIdentity: entry.state.identity,
            originalLink: entry.state,
            ...(entry.unverifiedOwnership && { recordedOnly: true })
        })
    }
    const links = await hardLinkPlan(inspection.app, transfers)
    if ('blocked' in links) return links
    return { action: { app: inspection.app, action: 'restore', base, transfers }, lines: [...lines, ...links.lines] }
}

async function applyAction(action: AppAction, prompts: LaunchPrompts, options: RelocationOptions): Promise<void> {
    const { app } = action
    if (options.dryRun) {
        prompts.log(`Dry run: ${app.label} would ${action.action === 'move' ? `move to ${action.base}` : 'be restored to its original paths'}.`)
        await options.report({ kind: 'previewed', appId: app.id, action: action.action })
        return
    }
    if (isActionRunning(action, await options.listProcesses())) {
        const reason = `${app.label} is running. Close it and try again.`
        prompts.log(`${reason} Nothing was changed.`)
        await options.report({ kind: 'skipped', appId: app.id, reason })
        return
    }
    const links = await hardLinkPlan(app, action.transfers)
    if ('blocked' in links) {
        const pending = action.transfers.filter((entry) => !entry.retained).map((entry) => entry.original)
        prompts.log(`${app.label}: ${links.blocked}. Nothing was changed.`)
        await options.report({
            kind: 'failed',
            appId: app.id,
            action: action.action,
            original: pending[0] ?? '',
            error: new Error(links.blocked),
            completed: [],
            notAttempted: pending
        })
        return
    }
    const transfer = action.action === 'move' ? moveDirectory : restoreDirectory
    const aliasKey = JSON.stringify([app.id, action.action, canonicalPathKey(action.base)])
    const copiedFiles: CopiedFiles = (await options.journal.readAliases?.(aliasKey)) ?? new Map()
    async function recordAliases(aliases: CopiedFiles): Promise<void> {
        await options.journal.saveAliases?.(aliasKey, aliases)
    }
    const completed: string[] = []
    for (const [index, { original, destination, destinationDirectories, nativeDependency, linkTargets, retained, recordedOnly, ...source }] of action.transfers.entries()) {
        let result: TransferResult
        try {
            if (retained) {
                await inspectDestinationPath(action.base, destination, source.kind === 'file' ? 'move' : 'restore', destinationDirectories)
                await readDirectoryIdentity(dirname(original))
                const state = await inspectPath(original, source.kind)
                if (
                    state.kind !== 'linked' ||
                    state.identity !== source.expectedIdentity ||
                    state.targetIdentity !== source.originalLink?.targetIdentity ||
                    !(await linksTo(original, destination))
                )
                    throw new UnverifiedPathError(`${original} no longer links directly to the verified destination ${destination}`)
                continue
            }
            const entry = app.paths.find((path) => path.path === original)
            const physical = source.originalLink?.target ?? original
            if (entry?.verifyFile && !(await entry.verifyFile(physical))) throw new Error(`Could not verify the app owns ${original}.`)
            if (recordedOnly) {
                if (action.action !== 'restore' || !source.originalLink || !recordedMirror(await options.journal.owner(original), source.originalLink))
                    throw new Error(`Could not verify that the toolkit created ${physical}.`)
            } else if (entry?.verifyDirectory && !(await entry.verifyDirectory(physical))) throw new Error(`Could not verify the app owns ${original}.`)
            if (
                action.action === 'move' &&
                source.originalLink &&
                !nativeDependency &&
                !relocationBaseOf(physical, options.home, original) &&
                !(await entry?.verifyLegacyTarget?.(physical))
            )
                throw new Error(`Could not verify the legacy target at ${physical}.`)
            result = await transfer(
                { appId: app.id, original, destination, ...source, base: action.base },
                {
                    journal: options.journal,
                    copiedFiles,
                    destinationDirectories,
                    recordAliases: async (aliases) => {
                        if (aliases.size) await recordAliases(aliases)
                    },
                    ...(nativeDependency && { trackRootAlias: true }),
                    ...(entry?.hardLinks === 'refuse-external' && { containedHardLinks: true }),
                    ...(linkTargets && { linkTargets }),
                    ...(app.preserveMirror && { preserveMirror: true })
                }
            )
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
    if (copiedFiles.size) await recordAliases(new Map())
    if (action.action === 'restore') {
        const remaining = await stillRelocated(app, action.base, options.home, options.journal)
        if (remaining.length > 0) {
            for (const path of remaining) prompts.log(`${app.label}: ${path} still links under ${action.base}.`)
            prompts.log('Return to the relocation checklist to restore the remaining paths after fixing the problem.')
            const error = new Error(`${remaining.join(', ')} still link under ${action.base}`)
            await options.report({ kind: 'failed', appId: app.id, action: 'restore', original: remaining[0] ?? '', error, completed, notAttempted: remaining })
            return
        }
    }
    prompts.log(action.action === 'move' ? `Moved ${app.label} to ${action.base}.` : `Restored ${app.label} to its original paths.`)
}

/** The app's paths that still link to its mirror under `base` after a restore. */
async function stillRelocated(app: RelocatableApp, base: string, home: string, journal: RecoveryJournal): Promise<string[]> {
    const remaining = new Map<string, string>()
    for (const entry of app.paths) {
        const state = await inspectPath(entry.path, entry.kind)
        const linkedBase = state.kind === 'linked' ? relocationBaseOf(state.target, home, entry.path) : null
        if (linkedBase && canonicalPathKey(linkedBase) === canonicalPathKey(base)) remaining.set(canonicalPathKey(entry.path), entry.path)
    }
    // A path the app relocated may no longer be in its configured paths, for example after the
    // npm prefix changed. The toolkit's receipts still name it.
    for (const [key, receipt] of await journal.owners()) {
        if (receipt.appId !== app.id || receipt.forwarding || remaining.has(key)) continue
        const original = receipt.original ?? key
        const state = await inspectPath(original, (await recordedKind(receipt)) ?? 'directory')
        if (state.kind === 'linked' && isPathInside(state.target, base)) remaining.set(key, original)
    }
    return [...remaining.values()]
}

async function recordedKind(receipt: MirrorOwner): Promise<'file' | undefined> {
    try {
        return (await lstat(receipt.path)).isFile() ? 'file' : undefined
    } catch (error) {
        if (isUnavailablePath(error)) return undefined
        throw error
    }
}

/** The paths this app relocated, from the toolkit's receipts, as restore-only catalog paths. */
async function recordedPaths(app: RelocatableApp, receipts: ReadonlyMap<string, MirrorOwner>): Promise<RelocationPath[]> {
    const paths: RelocationPath[] = []
    for (const [key, receipt] of receipts) {
        if (receipt.appId !== app.id || receipt.forwarding) continue
        const kind = await recordedKind(receipt)
        paths.push({ path: receipt.original ?? key, description: 'relocated path', recordedOnly: true, ...(kind && { kind }) })
    }
    return paths
}

/**
 * Inspects one catalog app with its recorded paths. When the app is blocked, by its
 * configuration or a path, the paths it already relocated are still offered for restore.
 */
async function inspectWithReceipts(
    app: RelocatableApp,
    receipts: ReadonlyMap<string, MirrorOwner>,
    prompts: LaunchPrompts,
    options: RelocationOptions,
    quiet: boolean
): Promise<AppInspection | null> {
    const validation = { ...options, owner: (original: string) => options.journal.owner(original) }
    const recorded = await recordedPaths(app, receipts)
    const extra = recorded.filter((entry) => !app.paths.some((path) => canonicalPathKey(path.path) === canonicalPathKey(entry.path)))
    const inspection = app.blocked ? { blocked: app.blocked } : await inspectApp(extra.length > 0 ? { ...app, paths: [...app.paths, ...extra] } : app, options.home, validation)
    if (!('blocked' in inspection)) return inspection
    if (!quiet) prompts.log(`${app.label} cannot be relocated. ${inspection.blocked}`)
    if (recorded.length === 0) return null
    // Blocking stops a new move, never a restore of what the toolkit already relocated.
    const restoreOnly: RelocatableApp = { id: app.id, label: app.label, processGuardId: app.processGuardId, paths: recorded, ...(app.preserveMirror && { preserveMirror: true }) }
    const fallback = await inspectApp(restoreOnly, options.home, validation)
    if ('blocked' in fallback) {
        if (!quiet) prompts.log(`${app.label}'s relocated paths cannot be restored yet. ${fallback.blocked}`)
        return null
    }
    if (fallback.applicable.length > 0 && !quiet) prompts.log(`${app.label}'s relocated paths can still be restored. Leave it clear to restore them.`)
    return fallback
}

/** Receipts from earlier versions name no app. Report those whose original still links to its mirror. */
async function reportUnattributedReceipts(receipts: ReadonlyMap<string, MirrorOwner>, catalog: readonly RelocatableApp[], prompts: LaunchPrompts): Promise<void> {
    const known = new Set(catalog.flatMap((app) => app.paths.map((entry) => canonicalPathKey(entry.path))))
    for (const [key, receipt] of receipts) {
        if (receipt.appId || receipt.forwarding || known.has(key)) continue
        const original = receipt.original ?? key
        const state = await inspectPath(original, (await recordedKind(receipt)) ?? 'directory')
        if (state.kind === 'linked' && recordedMirror(receipt, state)) prompts.log(`${original} still links to ${receipt.path}. Keep that drive until the path is restored.`)
    }
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
            const receipts = await options.journal.owners()
            const catalog: AppInspection[] = []
            for (const app of options.catalog) {
                const inspection = await inspectWithReceipts(app, receipts, prompts, options, held.has(app.id))
                if (inspection) catalog.push(inspection)
            }
            await reportUnattributedReceipts(receipts, options.catalog, prompts)
            const inspections: AppInspection[] = []
            for (const [index, claimed] of (await claimRelocationPaths(catalog, options.home, options)).entries()) {
                const app = catalog[index]!.app
                if ('blocked' in claimed) {
                    if (!held.has(app.id) && catalog[index]!.applicable.length > 0) prompts.log(`${app.label} cannot be relocated. ${claimed.blocked}`)
                    continue
                }
                if (!held.has(app.id) && claimed.applicable.length > 0) inspections.push(claimed)
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
                const originals = toMove.flatMap((inspection) => inspection.applicable.map((entry) => (entry.state.kind === 'linked' ? dirname(entry.path) : entry.path)))
                const base = await askForBase(prompts, options, originals, suggestion)
                if (base === cancelled) return cancelled
                for (const inspection of toMove) {
                    const plan = await planMove(inspection, base, options.home, options.journal)
                    if ('blocked' in plan) {
                        prompts.log(`${inspection.app.label} cannot move: ${plan.blocked}.`)
                        continue
                    }
                    actions.push(plan.action)
                    lines.push(...plan.lines)
                }
            }
            for (const { inspection, base } of toRestore) {
                const plan = await planRestore(inspection, base, options.journal)
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
                if (isActionRunning(action, processes)) lines.push(`${action.app.label} is running. Close it before applying, or it will be skipped.`)
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
