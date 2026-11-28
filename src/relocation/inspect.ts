import { lstat, readlink, realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import { canonicalPathKey } from '../core/filesystem/index.ts'
import { entryIdentity, hasErrorCode, isPathInside, isUnavailablePath, UnverifiedPathError } from '../core/filesystem/paths.ts'
import { errorMessage } from '../core/format.ts'
import { windowsDriveType } from '../windows/drives.ts'
import { inspectDirectoryPath, storedLinkTarget } from './directory-path.ts'
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
    validation: Pick<BaseValidationOptions, 'driveType' | 'volumesDiffer'> = { driveType: windowsDriveType, volumesDiffer: differentVolumes }
): Promise<AppInspection | { blocked: string }> {
    const outside = app.paths.find((entry) => !isPathInside(entry.path, home))
    if (outside) return { blocked: `${outside.path} is outside the Windows profile ${home}` }
    const inspected: InspectedPath[] = []
    for (const entry of app.paths) {
        let state = await inspectPath(entry.path, entry.kind, entry.verifyLegacyTarget)
        if (entry.verifyFile && (state.kind === 'local' || state.kind === 'linked') && !(await entry.verifyFile(state.kind === 'linked' ? state.target : entry.path))) {
            state = { kind: 'unsupported', reason: `Could not verify the app owns ${entry.path}` }
        }
        const verifiedLegacy =
            state.kind === 'linked' &&
            !!entry.verifyLegacyTarget &&
            basename(state.target).toLowerCase() === basename(entry.path).toLowerCase() &&
            (await entry.verifyLegacyTarget(state.target))
        inspected.push({ ...entry, state, verifiedLegacy })
    }
    const applicable = inspected
        .filter((entry) => entry.state.kind !== 'missing')
        .map((entry) => {
            const owner = inspected.find((candidate) => candidate.path === entry.nativeLauncherRoot)
            const root = owner?.state.kind === 'linked' ? owner.state.target : owner?.state.kind === 'local' ? owner.path : undefined
            return Object.assign(entry, { nativeDependency: !!root && entry.state.kind === 'linked' && isPathInside(entry.state.target, root) })
        })

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
