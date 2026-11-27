import { lstat, realpath } from 'node:fs/promises'

import { canonicalPathKey } from '../core/filesystem/index.ts'
import { hasErrorCode } from '../core/filesystem/paths.ts'
import { mirroredPath, relocationBaseOf } from './layout.ts'
import type { RelocatableApp, RelocationPath } from './types.ts'

/** Where an app path currently stores its data. */
export type PathState =
    | { readonly kind: 'missing' }
    | { readonly kind: 'local' }
    | { readonly kind: 'linked'; readonly target: string }
    | { readonly kind: 'unsupported'; readonly reason: string }

export interface InspectedPath extends RelocationPath {
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

export async function inspectPath(path: string): Promise<PathState> {
    let stats
    try {
        stats = await lstat(path)
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { kind: 'missing' }
        throw error
    }
    if (stats.isSymbolicLink()) {
        try {
            const target = await realpath(path)
            if (!(await lstat(target)).isDirectory()) return { kind: 'unsupported', reason: `${path} links to ${target}, which is not a directory` }
            return { kind: 'linked', target }
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return { kind: 'unsupported', reason: `${path} links to a missing directory` }
            throw error
        }
    }
    if (!stats.isDirectory()) return { kind: 'unsupported', reason: `${path} is not a directory` }
    if (canonicalPathKey(await realpath(path)) !== canonicalPathKey(path)) {
        return { kind: 'unsupported', reason: `${path} is reached through a linked parent directory` }
    }
    return { kind: 'local' }
}

/**
 * Inspects each configured path. The app is migrated only when every applicable path links to
 * its mirrored destination under one base.
 */
export async function inspectApp(app: RelocatableApp, home: string): Promise<AppInspection> {
    const inspected: InspectedPath[] = []
    for (const entry of app.paths) inspected.push({ ...entry, state: await inspectPath(entry.path) })
    const applicable = inspected.filter((entry) => entry.state.kind !== 'missing')

    const nonLocal = applicable.filter((entry) => entry.state.kind !== 'local')
    const bases = nonLocal.map((entry) => (entry.state.kind === 'linked' ? relocationBaseOf(entry.state.target, home, entry.path) : null))
    const [first] = bases
    const restoreBase = first && bases.every((base) => base !== null && canonicalPathKey(base) === canonicalPathKey(first)) ? first : null
    const migratedBase = nonLocal.length === applicable.length ? restoreBase : null
    return { app, applicable, migratedBase, restoreBase }
}

/** What moving one applicable path under `base` involves. */
export type MoveStep =
    | { readonly kind: 'move'; readonly path: string; readonly destination: string }
    | { readonly kind: 'in-place'; readonly path: string; readonly destination: string }
    | { readonly kind: 'blocked'; readonly path: string; readonly reason: string }

export function moveSteps(inspection: AppInspection, base: string, home: string): MoveStep[] {
    return inspection.applicable.map((entry): MoveStep => {
        const destination = mirroredPath(base, home, entry.path)
        switch (entry.state.kind) {
            case 'linked':
                return canonicalPathKey(entry.state.target) === canonicalPathKey(destination)
                    ? { kind: 'in-place', path: entry.path, destination }
                    : { kind: 'blocked', path: entry.path, reason: `${entry.path} links to ${entry.state.target}. Consolidating existing links is not supported yet` }
            case 'unsupported':
                return { kind: 'blocked', path: entry.path, reason: entry.state.reason }
            default:
                return { kind: 'move', path: entry.path, destination }
        }
    })
}
