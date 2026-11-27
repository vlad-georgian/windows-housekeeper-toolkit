import { lstat, stat } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'

import { canonicalPathKey, isPathInside } from '../core/filesystem/index.ts'
import { hasErrorCode, isUnavailablePath, UnverifiedPathError } from '../core/filesystem/paths.ts'
import { errorMessage } from '../core/format.ts'
import type { DriveKind, DriveTypeLookup } from '../windows/drives.ts'
import { inspectDirectoryPath } from './directory-path.ts'

export type { DriveKind, DriveTypeLookup } from '../windows/drives.ts'

/** Whether two paths are stored on different volumes. Either path may not exist yet. */
export type VolumeComparison = (first: string, second: string) => Promise<boolean>

function profileRelativePath(home: string, original: string): string {
    if (!isPathInside(original, home)) throw new Error(`${original} is outside the Windows profile ${home}.`)
    return join(basename(resolve(home)), relative(resolve(home), resolve(original)))
}

/** The relocation destination of `original`: `<base>\<profile name>\<profile-relative path>`. */
export function mirroredPath(base: string, home: string, original: string): string {
    return join(resolve(base), profileRelativePath(home, original))
}

/** The base whose mirrored layout places `original` at `destination`, or `null` when none does. */
export function relocationBaseOf(destination: string, home: string, original: string): string | null {
    const suffix = `${sep}${profileRelativePath(home, original)}`.toLowerCase()
    const resolved = resolve(destination)
    if (!canonicalPathKey(resolved).endsWith(suffix)) return null
    const base = resolved.slice(0, resolved.length - suffix.length)
    return /^[a-z]:$/i.test(base) ? `${base}${sep}` : base
}

export async function nearestExistingPath(path: string): Promise<string> {
    let current = resolve(path)
    for (;;) {
        try {
            await lstat(current)
            return current
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT') || dirname(current) === current) throw error
            current = dirname(current)
        }
    }
}

/** Compares the volume serial numbers of the nearest existing ancestors. */
export const differentVolumes: VolumeComparison = async (first, second) => {
    const [a, b] = await Promise.all([nearestExistingPath(first), nearestExistingPath(second)])
    const [statsA, statsB] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })])
    return statsA.dev !== statsB.dev
}

const driveDescriptions: Readonly<Record<Exclude<DriveKind, 'fixed'>, string>> = {
    removable: 'is a removable drive',
    network: 'is a network drive',
    substituted: 'is a substituted drive',
    other: 'is not a fixed local drive'
}

export interface BaseValidationOptions {
    readonly home: string
    /** Paths on the source volumes, using the original parent for an already-linked path. */
    readonly originals: readonly string[]
    readonly volumesDiffer: VolumeComparison
    readonly driveType: DriveTypeLookup
}

/** Returns why `base` cannot hold relocated apps, or `null` when it can. */
export async function validateRelocationBase(base: string, { home, originals, volumesDiffer, driveType }: BaseValidationOptions): Promise<string | null> {
    if (!/^[a-z]:[\\/]/i.test(base) || /[*?"<>|]/u.test(base.slice(2))) return 'Enter an absolute path on a local drive, such as E:\\Software.'
    const resolved = resolve(base)
    const root = parse(resolved).root
    const kind = await driveType(root)
    if (kind !== 'fixed') return `${root} ${driveDescriptions[kind]}. Choose a base on a fixed local drive.`
    const key = canonicalPathKey(resolved)
    if (key === canonicalPathKey(home) || isPathInside(resolved, home) || isPathInside(home, resolved)) {
        return 'Choose a base outside the Windows profile.'
    }

    try {
        await inspectDirectoryPath(resolved)
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return `${errorMessage(error)}. Choose another base.`
        throw error
    }

    for (const original of originals) {
        if (!(await volumesDiffer(resolved, original))) return `Choose a base on another drive than ${parse(resolve(original)).root}.`
    }
    return null
}
