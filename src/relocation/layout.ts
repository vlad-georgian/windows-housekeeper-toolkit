import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'

import { canonicalPathKey, isPathInside } from '../core/filesystem/index.ts'
import { hasErrorCode } from '../core/filesystem/paths.ts'

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

export interface BaseValidationOptions {
    readonly home: string
    /** The original paths that will move under the base. */
    readonly originals: readonly string[]
    readonly volumesDiffer: VolumeComparison
}

/** Returns why `base` cannot hold relocated apps, or `null` when it can. */
export async function validateRelocationBase(base: string, { home, originals, volumesDiffer }: BaseValidationOptions): Promise<string | null> {
    if (!/^[a-z]:[\\/]/i.test(base) || /[*?"<>|]/u.test(base.slice(2))) return 'Enter an absolute path on a local drive, such as E:\\Software.'
    const resolved = resolve(base)
    const key = canonicalPathKey(resolved)
    if (key === canonicalPathKey(home) || isPathInside(resolved, home) || isPathInside(home, resolved)) {
        return 'Choose a base outside the Windows profile.'
    }

    const existing = await nearestExistingPath(resolved)
    const stats = await lstat(existing)
    if (stats.isSymbolicLink() || canonicalPathKey(await realpath(existing)) !== canonicalPathKey(existing)) {
        return `${existing} resolves through a link. Choose its real location instead.`
    }
    if (!stats.isDirectory()) return `${existing} is not a directory.`

    for (const original of originals) {
        if (!(await volumesDiffer(resolved, original))) return `Choose a base on another drive than ${parse(resolve(original)).root}.`
    }
    return null
}
