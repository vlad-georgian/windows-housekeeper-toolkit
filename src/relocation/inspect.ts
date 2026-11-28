import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import { canonicalPathKey } from '../core/filesystem/index.ts'
import { entryIdentity, hasErrorCode, isPathInside, isUnavailablePath, UnverifiedPathError } from '../core/filesystem/paths.ts'
import { errorMessage } from '../core/format.ts'
import { windowsDriveType } from '../windows/drives.ts'
import { inspectDirectoryPath, storedLinkTarget } from './directory-path.ts'
import type { MirrorOwner } from './journal.ts'
import { type BaseValidationOptions, differentVolumes, mirroredPath, relocationBaseOf, validateRelocationBase } from './layout.ts'
import type { RelocatableApp, RelocationPath } from './types.ts'

/** Where an app path currently stores its data. */
export interface OriginalLink {
    readonly target: string
    readonly payload: string
    readonly identity: string
    readonly targetIdentity: string
    readonly indirect?: true
}

export type PathState =
    | { readonly kind: 'missing' }
    | { readonly kind: 'local'; readonly identity: string }
    | ({ readonly kind: 'linked' } & OriginalLink)
    | { readonly kind: 'unsupported'; readonly reason: string }

export interface InspectedPath extends RelocationPath {
    readonly verifiedLegacy?: boolean
    readonly nativeDependency?: boolean
    /**
     * The toolkit recorded this link, but the app's ownership evidence is gone, for example after
     * the last global package was removed. The path can be restored but not moved again.
     */
    readonly unverifiedOwnership?: true
    readonly state: PathState
}

export interface AppInspection {
    readonly app: RelocatableApp
    /** The configured paths that exist. */
    readonly applicable: readonly InspectedPath[]
    /** The base when the app is a migrated application, otherwise `null`. */
    readonly migratedBase: string | null
    /** The common mirrored base of all non-local paths, if they can be restored together. */
    readonly restoreBase: string | null
}

export async function inspectPath(path: string, kind: RelocationPath['kind'] = 'directory', verifyIndirect?: (target: string) => Promise<boolean>): Promise<PathState> {
    let stats
    try {
        stats = await lstat(path, { bigint: true })
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { kind: 'missing' }
        throw error
    }
    if (canonicalPathKey(await realpath(dirname(path))) !== canonicalPathKey(dirname(path))) return { kind: 'unsupported', reason: `${path} has a linked parent directory` }
    if (stats.isSymbolicLink()) {
        try {
            const target = await realpath(path)
            await inspectDirectoryPath(dirname(target))
            const targetStats = await lstat(target, { bigint: true })
            const payload = await readlink(path)
            const indirect = canonicalPathKey(await storedLinkTarget(path)) !== canonicalPathKey(target)
            if (indirect && !(await verifyIndirect?.(target))) return { kind: 'unsupported', reason: `${path} resolves through a link in its stored target` }
            if (kind === 'file' ? !targetStats.isFile() : !targetStats.isDirectory()) return { kind: 'unsupported', reason: `${path} does not point to a ${kind}` }
            return { kind: 'linked', target, payload, identity: entryIdentity(stats), targetIdentity: entryIdentity(targetStats), ...(indirect && { indirect: true }) }
        } catch (error) {
            if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return { kind: 'unsupported', reason: `${path} links to an unavailable target` }
            throw error
        }
    }
    if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) return { kind: 'unsupported', reason: `${path} is not a ${kind}` }
    if (canonicalPathKey(await realpath(path)) !== canonicalPathKey(path)) {
        return { kind: 'unsupported', reason: `${path} is reached through a linked parent directory` }
    }
    return { kind: 'local', identity: entryIdentity(stats) }
}

/**
 * Inspects each configured path. The app is migrated only when every applicable path links to
 * its mirrored destination under one base.
 */
export async function inspectApp(
    app: RelocatableApp,
    home: string,
    validation: RelocationValidation = { driveType: windowsDriveType, volumesDiffer: differentVolumes }
): Promise<AppInspection | { blocked: string }> {
    if (app.blocked) return { blocked: app.blocked }
    const outside = app.paths.find((entry) => !isPathInside(entry.path, home))
    if (outside) return { blocked: `${outside.path} is outside the Windows profile ${home}` }
    const inspected: InspectedPath[] = []
    for (const entry of app.paths) {
        let state = await inspectPath(entry.path, entry.kind, entry.verifyLegacyTarget)
        let unverifiedOwnership = false
        if (entry.verifyDirectory) {
            // Optional package paths need positive evidence before they are offered. A link the
            // toolkit recorded stays visible, so its data can always be restored or explained.
            const recorded = state.kind === 'linked' || state.kind === 'unsupported' ? await validation.owner?.(entry.path) : undefined
            if (state.kind === 'unsupported' && !recorded) continue
            if (state.kind === 'linked' && !relocationBaseOf(state.target, home, entry.path)) continue
            if ((state.kind === 'local' || state.kind === 'linked') && !(await entry.verifyDirectory(state.kind === 'linked' ? state.target : entry.path))) {
                if (state.kind !== 'linked' || !recordedMirror(recorded, state)) continue
                unverifiedOwnership = true
            }
        }
        if (entry.verifyFile && (state.kind === 'local' || state.kind === 'linked') && !(await entry.verifyFile(state.kind === 'linked' ? state.target : entry.path))) {
            state = { kind: 'unsupported', reason: `Could not verify the app owns ${entry.path}` }
        }
        const verifiedLegacy =
            state.kind === 'linked' &&
            !!entry.verifyLegacyTarget &&
            basename(state.target).toLowerCase() === basename(entry.path).toLowerCase() &&
            (await entry.verifyLegacyTarget(state.target))
        inspected.push({ ...entry, state, verifiedLegacy, ...(unverifiedOwnership && { unverifiedOwnership: true }) })
    }
    const applicable = inspected
        .filter((entry) => entry.state.kind !== 'missing')
        .map((entry) => {
            const owner = inspected.find((candidate) => candidate.path === entry.nativeLauncherRoot)
            const root = owner?.state.kind === 'linked' ? owner.state.target : owner?.state.kind === 'local' ? owner.path : undefined
            return Object.assign(entry, { nativeDependency: !!root && entry.state.kind === 'linked' && isPathInside(entry.state.target, root) })
        })
    return summarizeApp(app, applicable, home, validation)
}

type RelocationValidation = Pick<BaseValidationOptions, 'driveType' | 'volumesDiffer'> & {
    /** The toolkit's identity receipt for a destination it created. */
    readonly owner?: (original: string) => Promise<MirrorOwner | undefined>
}

/** Whether the toolkit's receipt proves it created the directory this link targets. */
export function recordedMirror(owner: MirrorOwner | undefined, link: OriginalLink): boolean {
    return !!owner && !owner.forwarding && owner.identity === link.targetIdentity && canonicalPathKey(owner.path) === canonicalPathKey(link.target)
}

async function summarizeApp(
    app: RelocatableApp,
    applicable: readonly InspectedPath[],
    home: string,
    validation: RelocationValidation
): Promise<AppInspection | { blocked: string }> {
    const nonLocal = applicable.filter((entry) => entry.state.kind !== 'local')
    for (const { state } of nonLocal) if (state.kind === 'unsupported') return { blocked: state.reason }
    const bases = nonLocal.map((entry) => (entry.state.kind === 'linked' && !entry.state.indirect ? relocationBaseOf(entry.state.target, home, entry.path) : null))
    const [first] = bases
    const restoreBase = first && bases.every((base) => base !== null && canonicalPathKey(base) === canonicalPathKey(first)) ? first : null
    if (restoreBase !== null) {
        try {
            const problem = await validateRelocationBase(restoreBase, { ...validation, home, originals: nonLocal.map((entry) => dirname(entry.path)) })
            if (problem !== null) return { blocked: `${restoreBase} is ineligible. ${problem}` }
        } catch (error) {
            return { blocked: `Could not verify the inferred base ${restoreBase}. ${errorMessage(error)}` }
        }
    }
    const migratedBase = nonLocal.length === applicable.length ? restoreBase : null
    return { app, applicable, migratedBase, restoreBase }
}

function physicalTree(entry: InspectedPath): string | null {
    if (entry.kind === 'file') return null
    if (entry.state.kind === 'local') return entry.path
    return entry.state.kind === 'linked' ? entry.state.target : null
}

/** Give exact names and descendants to one catalog owner before building the checklist.
 * Distinct names with overlapping backing trees need independent target ownership. */
export async function claimRelocationPaths(
    inspections: readonly AppInspection[],
    home: string,
    validation: RelocationValidation
): Promise<(AppInspection | { blocked: string })[]> {
    const entries = inspections.flatMap((inspection) => inspection.applicable)
    const claimed: InspectedPath[] = []
    for (const entry of entries.toSorted((a, b) => a.path.length - b.path.length)) {
        if (claimed.some((owner) => physicalTree(owner) !== null && isPathInside(entry.path, owner.path))) continue
        const duplicate = claimed.findIndex((owner) => canonicalPathKey(owner.path) === canonicalPathKey(entry.path))
        if (duplicate === -1) claimed.push(entry)
        else if (claimed[duplicate]?.state.kind === 'unsupported' && entry.state.kind !== 'unsupported') claimed[duplicate] = entry
    }
    const conflicts = new Map<InspectedPath, string>()
    for (const [index, entry] of claimed.entries()) {
        const tree = physicalTree(entry)
        if (!tree) continue
        for (const other of claimed.slice(index + 1)) {
            const backing = physicalTree(other)
            if (backing && (canonicalPathKey(tree) === canonicalPathKey(backing) || isPathInside(tree, backing) || isPathInside(backing, tree))) {
                conflicts.set(entry, other.path)
                conflicts.set(other, entry.path)
            }
        }
    }
    const owners = new Set(claimed)
    return Promise.all(
        inspections.map(async ({ app, applicable }) => {
            const paths: InspectedPath[] = []
            for (const entry of applicable) {
                if (!owners.has(entry)) continue
                const conflict = conflicts.get(entry)
                paths.push(conflict ? { ...entry, state: { kind: 'unsupported', reason: `${entry.path} shares a backing tree with ${conflict}` } } : entry)
            }
            return summarizeApp(app, paths, home, validation)
        })
    )
}

/** What moving one applicable path under `base` involves. */
export type MoveStep =
    | {
          readonly kind: 'move'
          readonly path: string
          readonly destination: string
          readonly originalLink?: OriginalLink
          readonly identity: string
          readonly file: boolean
          readonly nativeDependency?: boolean
      }
    | { readonly kind: 'in-place'; readonly originalLink: OriginalLink; readonly file: boolean; readonly path: string; readonly destination: string }
    | { readonly kind: 'blocked'; readonly path: string; readonly reason: string }

export function moveSteps(inspection: AppInspection, base: string, home: string): MoveStep[] {
    return inspection.applicable.map((entry): MoveStep => {
        if (entry.state.kind === 'unsupported') return { kind: 'blocked', path: entry.path, reason: entry.state.reason }
        const destination = mirroredPath(base, home, entry.path)
        switch (entry.state.kind) {
            case 'linked':
                if (entry.nativeDependency)
                    return { kind: 'move', path: entry.path, destination, originalLink: entry.state, identity: entry.state.identity, file: true, nativeDependency: true }
                if (!entry.state.indirect && canonicalPathKey(entry.state.target) === canonicalPathKey(destination))
                    return { kind: 'in-place', originalLink: entry.state, file: entry.kind === 'file', path: entry.path, destination }
                // Accept direct links to a previous profile mirror. A matching file or folder name alone
                // does not establish that a different physical tree belongs to this application.
                if ((!entry.verifiedLegacy && !relocationBaseOf(entry.state.target, home, entry.path)) || isPathInside(entry.state.target, home)) {
                    return { kind: 'blocked', path: entry.path, reason: `${entry.path} links to ${entry.state.target}, outside a verified profile mirror` }
                }
                return { kind: 'move', path: entry.path, destination, originalLink: entry.state, identity: entry.state.identity, file: entry.kind === 'file' }
            case 'missing':
                return { kind: 'blocked', path: entry.path, reason: `${entry.path} is missing` }
            default:
                return { kind: 'move', path: entry.path, destination, identity: entry.state.identity, file: entry.kind === 'file' }
        }
    })
}
