import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link, lstat, mkdir, readFile, realpath, rename, rm, rmdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { CleanupCandidate, RemovalCallbacks } from '../../core/types.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import type { ProcessLister, WindowsProcess } from '../../windows/processes.ts'
import { ScoopInstallationCleaner } from './scoop-cleaner.ts'

let sandbox: Sandbox
const scoop = join('Users', 'test', 'scoop')
const callbacks: RemovalCallbacks = { onRemoved: async () => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
    await sandbox.file(join(scoop, 'apps', 'scoop', 'current', 'bin', 'scoop.ps1'))
})
afterEach(() => sandbox.dispose())

const appPath = (app: string, ...parts: string[]): string => join(scoop, 'apps', app, ...parts)
const persistPath = (app: string, ...parts: string[]): string => join(scoop, 'persist', app, ...parts)

interface VersionOptions {
    /** `null` omits the bucket, as Scoop does for apps installed from a manifest URL or path. */
    readonly bucket?: string | null
    readonly url?: string
    readonly hold?: boolean
    readonly manifestVersion?: string
    readonly persistDirectories?: readonly string[]
    readonly withInstallMetadata?: boolean
}

/** A Scoop version directory with the manifest, install metadata, and persisted-data junctions Scoop writes. */
async function addVersion(app: string, version: string, options: VersionOptions = {}): Promise<void> {
    const { bucket = 'main', url, hold = false, manifestVersion = version, persistDirectories = [], withInstallMetadata = true } = options
    await sandbox.file(appPath(app, version, 'manifest.json'), JSON.stringify({ version: manifestVersion, persist: persistDirectories }))
    if (withInstallMetadata) {
        await sandbox.file(
            appPath(app, version, 'install.json'),
            JSON.stringify({ ...(bucket !== null && { bucket }), ...(url && { url }), architecture: '64bit', ...(hold && { hold: true }) })
        )
    }
    await sandbox.file(appPath(app, version, `${app}.exe`), version)
    for (const directory of persistDirectories) {
        await sandbox.directory(persistPath(app, directory))
        await symlink(join(sandbox.root, persistPath(app, directory)), join(sandbox.root, appPath(app, version, directory)), 'junction')
    }
}

async function select(app: string, version: string): Promise<void> {
    await symlink(join(sandbox.root, appPath(app, version)), join(sandbox.root, appPath(app, 'current')), 'junction')
}

async function addNode(versions: readonly string[], selected: string): Promise<void> {
    for (const version of versions) await addVersion('nodejs', version, { persistDirectories: ['bin', 'cache'] })
    await select('nodejs', selected)
}

const quiet = async (): Promise<WindowsProcess[]> => [{ id: 1, name: 'explorer.exe', path: join(sandbox.root, 'Windows', 'explorer.exe'), commandLine: null }]

const nodeAt = (id: number, path: string, commandLine: string | null = null): WindowsProcess => ({ id, name: 'node.exe', path, commandLine })

const processListing =
    (...processes: readonly WindowsProcess[]): ProcessLister =>
    async () =>
        processes
const failingListing: ProcessLister = async () => {
    throw new Error('inventory unavailable')
}

/** The message of the error a removal throws, or an empty string when it succeeds. */
async function failureOf(removal: Promise<unknown>): Promise<string> {
    try {
        await removal
        return ''
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
}

const cleaner = (listProcesses: ProcessLister = quiet): ScoopInstallationCleaner => new ScoopInstallationCleaner(sandbox.paths, {}, listProcesses)
const names = (candidates: readonly CleanupCandidate[]): string[] => candidates.map((candidate) => candidate.displayName).toSorted()
const exists = (path: string): Promise<boolean> =>
    lstat(join(sandbox.root, path)).then(
        () => true,
        () => false
    )

describe('Scoop installations', () => {
    test('offers versions older than the selected one, including Node.js, and protects the rest', async () => {
        await addNode(['22.1.0', '24.0.0', '24.2.0', '25.0.0'], '24.2.0')
        await addVersion('lazygit', '0.66.1')
        await select('lazygit', '0.66.1')
        await addVersion('lazygit', '0.60.0')

        const candidates = await cleaner().detect()
        expect(names(candidates)).toEqual(['Scoop lazygit 0.60.0', 'Scoop nodejs 22.1.0', 'Scoop nodejs 24.0.0'])
        expect(candidates.every((candidate) => candidate.reason.includes('persistent data'))).toBe(true)
    })

    test('removes old versions while the selected version and shared persistent data survive', async () => {
        await addNode(['22.1.0', '24.2.0'], '24.2.0')
        await sandbox.file(persistPath('nodejs', 'bin', 'npm.cmd'), 'npm')
        await sandbox.file(persistPath('nodejs', 'cache', 'index.json'), 'cache')
        const [old] = await cleaner().detect()
        if (!old) throw new Error('Expected an old Node.js version.')
        expect(old.fileCount).toBe(3)

        const removals: string[] = []
        await cleaner().remove(old, { onRemoved: async (entry) => void removals.push(entry.kind) })

        expect(await exists(appPath('nodejs', '22.1.0'))).toBe(false)
        expect(removals).toContain('link')
        expect(await readFile(join(sandbox.root, persistPath('nodejs', 'bin', 'npm.cmd')), 'utf8')).toBe('npm')
        expect(await readFile(join(sandbox.root, persistPath('nodejs', 'cache', 'index.json')), 'utf8')).toBe('cache')
        // The selected version still reaches the shared data through its own junctions.
        expect(await realpath(join(sandbox.root, appPath('nodejs', 'current', 'bin')))).toBe(await realpath(join(sandbox.root, persistPath('nodejs', 'bin'))))
        expect(await readFile(join(sandbox.root, appPath('nodejs', 'current', 'cache', 'index.json')), 'utf8')).toBe('cache')
        expect(await cleaner().detect()).toEqual([])
    })

    test('removes hard-linked persisted files without touching their shared copy', async () => {
        await addVersion('tool', '1.0.0')
        await addVersion('tool', '2.0.0')
        await select('tool', '2.0.0')
        await sandbox.file(appPath('tool', '1.0.0', 'manifest.json'), JSON.stringify({ version: '1.0.0', persist: ['settings.json'] }))
        await sandbox.file(persistPath('tool', 'settings.json'), 'saved')
        await link(join(sandbox.root, persistPath('tool', 'settings.json')), join(sandbox.root, appPath('tool', '1.0.0', 'settings.json')))

        const [old] = await cleaner().detect()
        if (!old) throw new Error('Expected an old version.')
        await cleaner().remove(old, callbacks)

        expect(await exists(appPath('tool', '1.0.0'))).toBe(false)
        expect(await readFile(join(sandbox.root, persistPath('tool', 'settings.json')), 'utf8')).toBe('saved')
    })

    test('skips a hard link that is not a declared persisted file', async () => {
        await addVersion('tool', '1.0.0')
        await addVersion('tool', '2.0.0')
        await select('tool', '2.0.0')
        await sandbox.file(persistPath('tool', 'settings.json'), 'saved')
        await link(join(sandbox.root, persistPath('tool', 'settings.json')), join(sandbox.root, appPath('tool', '1.0.0', 'settings.json')))

        expect(await cleaner().detect()).toEqual([])
    })

    test('skips ambiguous or incomplete versions', async () => {
        await addVersion('tool', '3.0.0')
        await select('tool', '3.0.0')
        await addVersion('tool', '2.0.0', { withInstallMetadata: false })
        await addVersion('tool', '1.9.0', { manifestVersion: '1.9.1' })
        await addVersion('tool', '1.8.0', { bucket: 'extras' })
        await addVersion('tool', '1.7.0', { hold: true })
        await addVersion('tool', 'nightly')
        await sandbox.file(appPath('tool', '_1.5.0.old', 'tool.exe'))
        await sandbox.file(appPath('tool', '1.4.0', 'tool.exe'))
        await addVersion('tool', '1.3.0')

        expect(names(await cleaner().detect())).toEqual(['Scoop tool 1.3.0'])
    })

    test('treats only releases from the same bucket or manifest URL as one channel', async () => {
        const manifest = 'https://example.test/tool.json'
        // Neither bucket nor URL recorded: the channel cannot be established.
        await addVersion('anonymous', '2.0.0', { bucket: null })
        await select('anonymous', '2.0.0')
        await addVersion('anonymous', '1.0.0', { bucket: null })
        // The same manifest URL is one channel; different manifests are not.
        await addVersion('sameurl', '2.0.0', { bucket: null, url: manifest })
        await select('sameurl', '2.0.0')
        await addVersion('sameurl', '1.0.0', { bucket: null, url: manifest })
        await addVersion('otherurl', '2.0.0', { bucket: null, url: manifest })
        await select('otherurl', '2.0.0')
        await addVersion('otherurl', '1.0.0', { bucket: null, url: 'https://example.test/fork.json' })
        // A bucket install and a URL install of the same app are different channels.
        await addVersion('mixed', '2.0.0')
        await select('mixed', '2.0.0')
        await addVersion('mixed', '1.0.0', { bucket: null, url: manifest })

        expect(names(await cleaner().detect())).toEqual(['Scoop sameurl 1.0.0'])
    })

    test('offers nothing when the selected version is not verifiable', async () => {
        await addVersion('noselection', '1.0.0')
        await addVersion('noselection', '2.0.0')
        await addVersion('incomplete', '1.0.0')
        await addVersion('incomplete', '2.0.0', { withInstallMetadata: false })
        await select('incomplete', '2.0.0')
        await addVersion('copied', '1.0.0')
        await sandbox.file(appPath('copied', 'current', 'copied.exe'))

        expect(await cleaner().detect()).toEqual([])
    })

    test('skips versions that link anywhere other than shared persistent data', async () => {
        await addNode(['22.1.0', '24.2.0'], '24.2.0')
        await sandbox.directory(join('Users', 'test', 'Documents'))
        await symlink(join(sandbox.root, 'Users', 'test', 'Documents'), join(sandbox.root, appPath('nodejs', '22.1.0', 'docs')), 'junction')

        expect(await cleaner().detect()).toEqual([])
    })

    test('offers nothing unless a per-user Scoop installation is verified', async () => {
        await rmScoopCore()
        await addNode(['22.1.0', '24.2.0'], '24.2.0')
        expect(await cleaner().detect()).toEqual([])
    })

    test('skips versions that are in use and anything it cannot verify', async () => {
        await addNode(['22.1.0', '24.0.0', '24.2.0'], '24.2.0')
        const inUse = processListing(nodeAt(7, join(sandbox.root, appPath('nodejs', '22.1.0', 'nodejs.exe'))))
        const viaScript = processListing(nodeAt(8, join(sandbox.root, 'elsewhere', 'node.exe'), `node ${join(sandbox.root, appPath('nodejs', '24.0.0', 'app.js'))}`))

        expect(names(await cleaner(inUse).detect())).toEqual(['Scoop nodejs 24.0.0'])
        expect(names(await cleaner(viaScript).detect())).toEqual(['Scoop nodejs 22.1.0'])
        expect(await cleaner(failingListing).detect()).toEqual([])
    })

    test('checks a relocated version by its resolved path as well', async () => {
        await addNode(['22.1.0', '24.2.0'], '24.2.0')
        // Relocate the app directory and leave a junction behind, as a moved Scoop installation would.
        const relocated = join(sandbox.root, 'Users', 'test', 'relocated')
        await mkdir(relocated, { recursive: true })
        await rename(join(sandbox.root, appPath('nodejs')), join(relocated, 'nodejs'))
        await symlink(join(relocated, 'nodejs'), join(sandbox.root, appPath('nodejs')), 'junction')
        const resolved = processListing(nodeAt(5, join(relocated, 'nodejs', '22.1.0', 'nodejs.exe')))

        expect(await cleaner().detect()).toHaveLength(1)
        expect(await cleaner(resolved).detect()).toEqual([])
    })

    test('rechecks the selected version before removal', async () => {
        await addNode(['22.1.0', '24.0.0', '24.2.0'], '24.2.0')
        const candidates = await cleaner().detect()
        const target = candidates.find((candidate) => candidate.displayName.endsWith('24.0.0'))
        if (!target) throw new Error('Expected 24.0.0 to be offered.')

        // Scoop resets the app to the version selected for removal after detection.
        await rmCurrent('nodejs')
        await select('nodejs', '24.0.0')

        expect(await failureOf(cleaner().remove(target, callbacks))).toContain('changed after detection')
        expect(await exists(appPath('nodejs', '24.0.0', 'nodejs.exe'))).toBe(true)
        expect(await exists(persistPath('nodejs', 'bin'))).toBe(true)
    })

    test('rechecks in-use status before removal', async () => {
        await addNode(['22.1.0', '24.2.0'], '24.2.0')
        const [target] = await cleaner().detect()
        if (!target) throw new Error('Expected an old version.')
        const started = processListing({ id: 9, name: 'node.exe', path: join(sandbox.root, appPath('nodejs', '22.1.0', 'nodejs.exe')), commandLine: null })

        expect(await failureOf(cleaner(started).remove(target, callbacks))).toContain('in use')
        expect(await exists(appPath('nodejs', '22.1.0', 'nodejs.exe'))).toBe(true)
        expect(await exists(appPath('nodejs', '22.1.0', 'bin'))).toBe(true)
    })

    test('refuses to remove a version that gained an unverified link after detection', async () => {
        await addNode(['22.1.0', '24.2.0'], '24.2.0')
        const [target] = await cleaner().detect()
        if (!target) throw new Error('Expected an old version.')
        await sandbox.directory(join('Users', 'test', 'Documents'))
        await sandbox.file(join('Users', 'test', 'Documents', 'keep.txt'))
        await symlink(join(sandbox.root, 'Users', 'test', 'Documents'), join(sandbox.root, appPath('nodejs', '22.1.0', 'docs')), 'junction')

        expect(await failureOf(cleaner().remove(target, callbacks))).toContain('changed after detection')
        expect(await exists(join('Users', 'test', 'Documents', 'keep.txt'))).toBe(true)
        // Nothing was unlinked before the refusal.
        expect(await exists(appPath('nodejs', '22.1.0', 'nodejs.exe'))).toBe(true)
        expect(await exists(appPath('nodejs', '22.1.0', 'bin'))).toBe(true)
        expect(await exists(persistPath('nodejs', 'bin'))).toBe(true)
    })
})

function rmScoopCore(): Promise<void> {
    return rm(join(sandbox.root, scoop, 'apps', 'scoop'), { recursive: true })
}

function rmCurrent(app: string): Promise<void> {
    return rmdir(join(sandbox.root, appPath(app, 'current')))
}
