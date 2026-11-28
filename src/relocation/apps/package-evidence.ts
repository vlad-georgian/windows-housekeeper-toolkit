import { lstatSync, readFileSync } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { canonicalPathKey, hasErrorCode, isPathInside, isUnavailablePath } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'

export type PackageEnvironment = Readonly<Record<string, string | undefined>>

/** Where the catalog reads package-manager configuration that is not on disk under the profile. */
export interface PackageSources {
    readonly env: PackageEnvironment
    /** The machine-scope ChocolateyInstall value. `undefined` means none is set, and `null` means it could not be read. */
    readonly machineChocolatey: () => Promise<string | null | undefined>
}

/** A configured location, or why the active location cannot be determined. */
export type ConfiguredPath = { readonly path: string } | { readonly blocked: string }

const configLimit = 131_072

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

/**
 * Reads `package.json` directly under `root` as ownership evidence. Package managers such as
 * Bun hard-link installed manifests to their cache, so the link count is not part of the check.
 */
export async function packageManifest(root: string): Promise<Record<string, unknown> | null> {
    const path = join(root, 'package.json')
    try {
        if (!(await directEntry(path, 'file')) || (await lstat(path)).size > configLimit) return null
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
        return isRecord(parsed) ? parsed : null
    } catch (error) {
        if (error instanceof SyntaxError || isUnavailablePath(error)) return null
        throw error
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reads a small configuration file while the catalog is built. A missing file is `null`. A
 * link, an oversized file or an unreadable file returns a reason, because the active setting
 * cannot be known.
 */
export function readConfigFile(path: string): { readonly text: string } | { readonly blocked: string } | null {
    try {
        const stats = lstatSync(path)
        if (!stats.isFile()) return { blocked: `${path} is not a regular file` }
        if (stats.size > configLimit) return { blocked: `${path} is too large to read` }
        return { text: readFileSync(path, 'utf8') }
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return null
        return { blocked: `Could not read ${path}` }
    }
}

/** Expands `${NAME}` references as npm does, or returns `null` when a reference is undefined. */
export function expandEnvironment(value: string, env: PackageEnvironment): string | null {
    let missing = false
    const expanded = value.replace(/\$\{([^}]+)\}/gu, (_match, name: string) => {
        const resolved = environmentValue(env, name)
        if (resolved === undefined) missing = true
        return resolved ?? ''
    })
    return missing ? null : expanded
}

/** Requires every configured source to name the same absolute location. Sources whose precedence
 * is not documented must agree, so the catalog never offers a location that is not the active one. */
export function agreedPath(label: string, sources: readonly { readonly source: string; readonly value: string | undefined }[], fallback: string): ConfiguredPath {
    const configured = sources.filter((entry): entry is { source: string; value: string } => entry.value !== undefined)
    const relative = configured.find((entry) => !isAbsolute(entry.value))
    if (relative) return { blocked: `${label} in ${relative.source} is not an absolute path` }
    const [first] = configured
    if (!first) return { path: fallback }
    const conflict = configured.find((entry) => !samePath(entry.value, first.value))
    if (conflict) return { blocked: `${label} is set to ${first.value} by ${first.source} and to ${conflict.value} by ${conflict.source}` }
    return { path: resolve(first.value) }
}

/** Windows profile variables used in package-manager configuration, with the profile's own values as defaults. */
export function profileEnvironment(paths: SystemPaths, env: PackageEnvironment): PackageEnvironment {
    return { USERPROFILE: paths.home, HOME: paths.home, APPDATA: paths.roamingAppData, LOCALAPPDATA: paths.localAppData, ...env }
}

/** The value of an environment variable, matched without regard to case as Windows does. */
export function environmentValue(env: PackageEnvironment, name: string): string | undefined {
    if (env[name] !== undefined) return env[name]
    return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
}
