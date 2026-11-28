import { join } from 'node:path'

import { listDirectoryNames } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp, RelocationPath } from '../types.ts'
import {
    agreedPath,
    type ConfiguredPath,
    directEntry,
    environmentValue,
    expandEnvironment,
    type PackageEnvironment,
    packageManifest,
    profileEnvironment,
    readConfigFile,
    userPath
} from './package-evidence.ts'
import { scoopRoots } from './scoop.ts'

async function hasPackage(store: string, scope = ''): Promise<boolean> {
    for (const name of await listDirectoryNames(store)) {
        if (name.startsWith('.')) continue
        const path = join(store, name)
        if (!(await directEntry(path, 'directory'))) continue
        if (!scope && name.startsWith('@')) {
            if (await hasPackage(path, `${name}/`)) return true
            continue
        }
        const manifest = await packageManifest(path)
        if (manifest?.name === `${scope}${name}` && typeof manifest.version === 'string') return true
    }
    return false
}

type NpmSettings = Partial<Record<'prefix' | 'cache', string>>

/** The `prefix` and `cache` settings in one npmrc file, with `${NAME}` references expanded. */
function readNpmrc(path: string, env: PackageEnvironment): NpmSettings | { blocked: string } {
    const file = readConfigFile(path)
    if (!file) return {}
    if ('blocked' in file) return file
    const settings: NpmSettings = {}
    for (const raw of file.text.split(/\r?\n/u)) {
        const line = raw.trim()
        if (!line || line.startsWith(';') || line.startsWith('#')) continue
        const match = /^(prefix|cache)\s*=\s*(.*)$/iu.exec(line)
        if (!match?.[1] || match[2] === undefined) continue
        const unquoted = match[2].trim().replace(/^"(.*)"$/u, '$1')
        const value = expandEnvironment(unquoted, env)
        if (value === null) return { blocked: `${path} refers to an undefined variable in ${match[1]}` }
        if (match[1].toLowerCase() === 'prefix') settings.prefix = value
        else settings.cache = value
    }
    return settings
}

/**
 * npm's active global prefix and cache, in npm's order: environment, user npmrc, then the
 * npmrc bundled with each known per-user Node.js. Bundled files that disagree make the active
 * location depend on which Node.js runs, so npm is not offered.
 * [npm config](https://docs.npmjs.com/cli/configuring-npm/npmrc)
 */
export function npmLocations(paths: SystemPaths, rawEnv: PackageEnvironment): { prefix: ConfiguredPath; cache: ConfiguredPath } {
    const env = profileEnvironment(paths, rawEnv)
    const user = readNpmrc(environmentValue(env, 'NPM_CONFIG_USERCONFIG') ?? join(paths.home, '.npmrc'), env)
    if ('blocked' in user) return { prefix: user, cache: user }
    const userSettings: NpmSettings = user
    const scoop = scoopRoots(paths, rawEnv).root
    // Scoop's Node.js can set the prefix. Without Scoop's root that setting cannot be read.
    if ('blocked' in scoop) return { prefix: scoop, cache: scoop }
    const nodeRoots = [join(paths.localAppData, 'Programs', 'nodejs'), join(paths.localAppData, 'nodejs')]
    for (const name of ['nodejs', 'nodejs-lts']) nodeRoots.push(join(scoop.path, 'apps', name, 'current'))
    const bundled: { source: string; settings: NpmSettings }[] = []
    for (const root of nodeRoots) {
        const source = join(root, 'node_modules', 'npm', 'npmrc')
        const settings = readNpmrc(source, env)
        if ('blocked' in settings) return { prefix: settings, cache: settings }
        bundled.push({ source, settings })
    }
    function locate(key: keyof NpmSettings, fallback: string): ConfiguredPath {
        const chosen = environmentValue(env, `npm_config_${key}`) ?? userSettings[key]
        if (chosen !== undefined) return agreedPath(`npm ${key}`, [{ source: 'the npm user configuration', value: chosen }], fallback)
        return agreedPath(
            `npm ${key}`,
            bundled.map(({ source, settings }) => ({ source, value: settings[key] })),
            fallback
        )
    }
    const prefix = locate('prefix', join(paths.roamingAppData, 'npm'))
    const cache = locate('cache', join(paths.localAppData, 'npm-cache'))
    // npm also reads `<prefix>\etc\npmrc`, which can change the cache after the prefix is known.
    if ('path' in prefix && readConfigFile(join(prefix.path, 'etc', 'npmrc'))) {
        const blocked = { blocked: `npm reads further configuration from ${join(prefix.path, 'etc', 'npmrc')}` }
        return { prefix: blocked, cache: blocked }
    }
    return { prefix, cache }
}

export function npmRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const app = { id: 'npm', label: 'npm', processGuardId: 'npm-cache' }
    const locations = npmLocations(paths, env)
    if ('blocked' in locations.prefix) return { ...app, blocked: locations.prefix.blocked, paths: [] }
    if ('blocked' in locations.cache) return { ...app, blocked: locations.cache.blocked, paths: [] }
    // A location inside Scoop's root, such as Scoop Node.js's prefix in `persist`, moves with Scoop.
    const prefix = userPath(locations.prefix.path, paths)
    const cache = userPath(locations.cache.path, paths)
    const candidates: RelocationPath[] = []
    if (prefix) candidates.push({ path: join(prefix, 'node_modules'), description: 'npm global packages', verifyDirectory: hasPackage })
    if (cache) {
        candidates.push({
            path: join(cache, '_cacache'),
            description: 'npm content cache',
            async verifyDirectory(target) {
                return (await directEntry(join(target, 'content-v2'), 'directory')) && (await directEntry(join(target, 'index-v5'), 'directory'))
            }
        })
    }
    return { ...app, paths: candidates }
}
