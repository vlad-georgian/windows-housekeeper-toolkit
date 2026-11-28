import { join } from 'node:path'

import { listDirectoryNames, pathExists } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp, RelocationPath } from '../types.ts'
import { agreedPath, directEntry, environmentValue, overlaps, type PackageEnvironment, packageManifest, readConfigFile, userPath } from './package-evidence.ts'

type BunSetting = 'install.globalDir' | 'install.globalBinDir' | 'install.cache.dir'
const settings: readonly BunSetting[] = ['install.globalDir', 'install.globalBinDir', 'install.cache.dir']

const escapes: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\u001b', '"': '"', '\\': '\\' }

/** Decodes a TOML basic string body, or returns `null` for an escape TOML does not define. */
function basicString(body: string): string | null {
    let invalid = false
    const decoded = body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gu, (_match, escape: string) => {
        if (escape.length > 1) {
            const code = Number.parseInt(escape.slice(1), 16)
            if (code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) return String.fromCodePoint(code)
        } else if (escapes[escape] !== undefined) return escapes[escape]
        invalid = true
        return ''
    })
    return invalid ? null : decoded
}

const keyPart = String.raw`(?:[\w-]+|"[^"]*"|'[^']*')`
const dottedKey = String.raw`${keyPart}(?:\s*\.\s*${keyPart})*`
const keyValue = new RegExp(String.raw`^(${dottedKey})\s*=\s*(.*)$`, 'u')
// `[table]` and `[[array of tables]]` both start a new section.
const tableHeader = new RegExp(String.raw`^\[\[?\s*(${dottedKey})\s*\]\]?\s*(?:#.*)?$`, 'u')

/** A dotted TOML key without quotes or the whitespace TOML allows around its dots. */
function normalizedKey(key: string): string {
    return [...key.matchAll(new RegExp(keyPart, 'gu'))]
        .map(
            ([part]) =>
                /^(?:"(.*)"|'(.*)')$/u
                    .exec(part)
                    ?.slice(1)
                    .find((value) => value !== undefined) ?? part
        )
        .join('.')
}

/**
 * The install locations in one global `bunfig.toml`. Only single-line string values are
 * understood. Anything else in an `install` table, or any other form of a location setting,
 * returns a reason instead, so the active location is never guessed.
 */
function readBunfig(path: string): Partial<Record<BunSetting, string>> | { blocked: string } {
    const file = readConfigFile(path)
    if (!file) return {}
    if ('blocked' in file) return file
    const found: Partial<Record<BunSetting, string>> = {}
    let section = ''
    for (const raw of file.text.replace(/^﻿/u, '').split(/\r?\n/u)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const header = tableHeader.exec(line)
        if (header?.[1]) {
            section = normalizedKey(header[1])
            continue
        }
        const pair = keyValue.exec(line)
        if (!pair?.[1] || pair[2] === undefined) {
            if (section === 'install' || section.startsWith('install.') || /\binstall\b/u.test(line)) {
                return { blocked: `${path} has a line the relocation catalog does not read: ${line}` }
            }
            continue
        }
        const key = [section, normalizedKey(pair[1])].filter(Boolean).join('.')
        const setting = settings.find((name) => name === key || name.startsWith(`${key}.`))
        if (!setting) continue
        const unreadable = { blocked: `${path} sets ${key} in a form the relocation catalog does not read` }
        const basic = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/u.exec(pair[2])
        const literal = /^'([^']*)'\s*(?:#.*)?$/u.exec(pair[2])
        if (setting !== key || (!basic && !literal)) return unreadable
        const decoded = basic?.[1] === undefined ? (literal?.[1] ?? null) : basicString(basic[1])
        if (decoded === null) return unreadable
        found[setting] = decoded
    }
    return found
}

/**
 * Bun's install locations from the environment and the global `bunfig.toml`. Bun documents
 * both sources without an order between them, so they must agree.
 * [bunfig.toml](https://bun.com/docs/runtime/bunfig#install)
 */
function bunLocations(paths: SystemPaths, env: PackageEnvironment) {
    const root = environmentValue(env, 'BUN_INSTALL') ?? join(paths.home, '.bun')
    const xdg = environmentValue(env, 'XDG_CONFIG_HOME')
    const files = [join(paths.home, '.bunfig.toml'), ...(xdg ? [join(xdg, '.bunfig.toml')] : [])]
    const configs: { source: string; values: Partial<Record<BunSetting, string>> }[] = []
    for (const source of files) {
        const values = readBunfig(source)
        if ('blocked' in values) return values
        configs.push({ source, values })
    }
    function locate(label: string, variable: string, setting: BunSetting, fallback: string) {
        return agreedPath(
            label,
            [{ source: variable, value: environmentValue(env, variable) }, ...configs.map(({ source, values }) => ({ source, value: values[setting] }))],
            fallback
        )
    }
    return {
        global: locate('The Bun global directory', 'BUN_INSTALL_GLOBAL_DIR', 'install.globalDir', join(root, 'install', 'global')),
        cache: locate('The Bun cache directory', 'BUN_INSTALL_CACHE_DIR', 'install.cache.dir', join(root, 'install', 'cache')),
        bin: locate('The Bun global bin directory', 'BUN_INSTALL_BIN', 'install.globalBinDir', join(root, 'bin'))
    }
}

export function bunRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const app = { id: 'bun', label: 'Bun', processGuardId: 'bun-relocation' }
    const locations = bunLocations(paths, env)
    if ('blocked' in locations) return { ...app, blocked: locations.blocked, paths: [] }
    for (const location of Object.values(locations)) if ('blocked' in location) return { ...app, blocked: location.blocked, paths: [] }
    if (!('path' in locations.global && 'path' in locations.cache && 'path' in locations.bin)) return { ...app, paths: [] }
    const global = userPath(locations.global.path, paths)
    const cache = userPath(locations.cache.path, paths)
    const bin = locations.bin.path
    const candidates: RelocationPath[] = []
    if (global && !overlaps(global, bin)) {
        candidates.push({
            path: global,
            description: 'Bun global packages',
            // Bun installs packages as hard links to its cache. Both trees move in one action, so
            // only names outside them, such as project installs, keep separate copies.
            hardLinks: 'report-external',
            async verifyDirectory(target) {
                const manifest = await packageManifest(target)
                return (
                    !!manifest?.dependencies &&
                    typeof manifest.dependencies === 'object' &&
                    ((await directEntry(join(target, 'bun.lock'), 'file')) || (await directEntry(join(target, 'bun.lockb'), 'file'))) &&
                    (await directEntry(join(target, 'node_modules'), 'directory'))
                )
            }
        })
    }
    if (cache && !overlaps(cache, bin) && (!global || !overlaps(cache, global))) {
        candidates.push({
            path: cache,
            description: 'Bun download cache',
            hardLinks: 'report-external',
            async verifyDirectory(target) {
                // Projects can point into the global store with symlinks. Leave the cache
                // in place when it contains that shared store.
                if (await pathExists(join(target, 'links'))) return false
                for (const name of await listDirectoryNames(target)) {
                    if (/@\d+\.\d+\.\d+/u.test(name) && typeof (await packageManifest(join(target, name)))?.name === 'string') return true
                }
                return false
            }
        })
    }
    return { ...app, paths: candidates }
}
