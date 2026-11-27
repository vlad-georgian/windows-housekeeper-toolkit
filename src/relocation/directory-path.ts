import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { canonicalPathKey, entryIdentity, hasErrorCode, isPathInside, UnverifiedPathError } from '../core/filesystem/paths.ts'

export interface DirectoryIdentity {
    readonly path: string
    readonly identity: string
}

function directoryComponents(path: string): string[] {
    const components: string[] = []
    for (let component = resolve(path); ; component = dirname(component)) {
        components.push(component)
        if (dirname(component) === component) return components.toReversed()
    }
}

export async function readDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
    const stats = await lstat(path, { bigint: true })
    if (stats.isSymbolicLink()) throw new UnverifiedPathError(`${path} resolves through a link`)
    if (!stats.isDirectory()) throw new UnverifiedPathError(`${path} is not a directory`)
    const canonical = await realpath(path)
    // Bun returns a bare drive letter for a drive root on Windows.
    const absolute = /^[a-z]:$/i.test(canonical) ? `${canonical}\\` : canonical
    if (canonicalPathKey(absolute) !== canonicalPathKey(path)) {
        throw new UnverifiedPathError(`${path} resolves through a link`)
    }
    return { path, identity: entryIdentity(stats) }
}

/** Captures every existing directory in order, and requires previously inspected directories to match. */
export async function inspectDirectoryPath(path: string, expected: readonly DirectoryIdentity[] = []): Promise<DirectoryIdentity[]> {
    const directories: DirectoryIdentity[] = []
    for (const component of directoryComponents(path)) {
        const previous = expected[directories.length]
        try {
            const current = await readDirectoryIdentity(component)
            if (previous && (previous.identity !== current.identity || canonicalPathKey(previous.path) !== canonicalPathKey(component))) {
                throw new UnverifiedPathError(`${component} was replaced after verification`)
            }
            directories.push(current)
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) throw error
            if (previous) throw new UnverifiedPathError(`${component} disappeared after verification`, { cause: error })
            break
        }
    }
    return directories
}

/** Checks containment and the directory chain without following a junction below the base. */
export function inspectDestinationPath(base: string, destination: string, action: 'move' | 'restore', expected?: readonly DirectoryIdentity[]): Promise<DirectoryIdentity[]> {
    if (!isPathInside(destination, base)) throw new UnverifiedPathError(`${destination} is outside the relocation base ${base}`)
    return inspectDirectoryPath(action === 'move' ? dirname(destination) : destination, expected)
}

export async function requireDirectoryIdentity(path: string, identity: string): Promise<void> {
    if ((await readDirectoryIdentity(path)).identity !== identity) throw new UnverifiedPathError(`${path} was replaced after verification`)
}

/** Creates missing parents individually so only successfully created directories are owned by the transfer. */
export async function createDestinationParents(path: string, expected: readonly DirectoryIdentity[], created: DirectoryIdentity[]): Promise<DirectoryIdentity[]> {
    const directories = await inspectDirectoryPath(path, expected)
    for (const component of directoryComponents(path).slice(directories.length)) {
        const parent = directories.at(-1)
        if (!parent) throw new UnverifiedPathError(`Cannot verify the parent of ${component}`)
        await requireDirectoryIdentity(parent.path, parent.identity)
        await mkdir(component)
        const current = await readDirectoryIdentity(component)
        directories.push(current)
        created.push(current)
    }
    return inspectDirectoryPath(path, directories)
}
