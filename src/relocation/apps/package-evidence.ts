import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { canonicalPathKey, isPathInside, isUnavailablePath, readSmallTextFile } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'

export type PackageEnvironment = Readonly<Record<string, string | undefined>>

export function userPath(value: string | undefined, paths: SystemPaths): string | null {
    if (!value || !isAbsolute(value)) return null
    const path = resolve(value)
    const forbidden = [paths.programData, join(paths.localAppData, 'Microsoft', 'WindowsApps'), join(paths.localAppData, 'Packages')]
    return isPathInside(path, paths.home) && !forbidden.some((root) => overlaps(path, root)) ? path : null
}

export function samePath(first: string, second: string): boolean {
    return canonicalPathKey(first) === canonicalPathKey(second)
}

export function overlaps(first: string, second: string): boolean {
    return samePath(first, second) || isPathInside(first, second) || isPathInside(second, first)
}

export async function directEntry(path: string, kind: 'file' | 'directory'): Promise<boolean> {
    try {
        const stats = await lstat(path)
        return (kind === 'file' ? stats.isFile() : stats.isDirectory()) && samePath(await realpath(path), path)
    } catch (error) {
        if (isUnavailablePath(error)) return false
        throw error
    }
}

export async function packageManifest(root: string): Promise<Record<string, unknown> | null> {
    const text = await readSmallTextFile(join(root, 'package.json'), root)
    if (!text) return null
    try {
        const parsed: unknown = JSON.parse(text)
        return isManifest(parsed) ? parsed : null
    } catch {
        return null
    }
}

function isManifest(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}
