import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link, readFile, rmdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import type { WindowsProcess } from '../../windows/processes.ts'
import { VitePlusInstallationCleaner } from './vite-plus-cleaner.ts'

let sandbox: Sandbox
// The monolithic layout of Vite+ 0.2 and earlier, and the split data directory of 0.3 and later.
const legacyHome = join('Users', 'test', '.vite-plus')
const splitData = join('Users', 'test', 'AppData', 'Local', 'vite-plus', 'data')
const store = join('Users', 'test', 'pnpm-store')
// Windows reports no path for system processes. They cannot be running from a user install.
const quietProcesses = async (): Promise<WindowsProcess[]> => [{ id: 4, name: 'System', path: null, commandLine: null }]
const unlocked = async (): Promise<boolean> => false
const held = async (): Promise<boolean> => true
// Windows hides the path of an elevated process from an unelevated tool.
const elevated = async (): Promise<WindowsProcess[]> => [{ id: 12, name: 'vp.exe', path: null, commandLine: null }]
const noop = { onRemoved: async (): Promise<void> => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

/**
 * A release as Vite+ installs it: a pnpm install whose `node_modules` holds a junction into the
 * virtual store and files hardlinked from the shared content store.
 */
async function addRelease(version: string, root = legacyHome, manifestVersion = version.split('+')[0]): Promise<string> {
    const release = join(root, version)
    await sandbox.file(join(release, 'package.json'), JSON.stringify({ name: 'vp-global', version: manifestVersion }))
    const binary = await sandbox.file(join(release, 'bin', 'vp.exe'))
    const virtual = join(release, 'node_modules', '.pnpm', `vite-plus@${manifestVersion}`, 'node_modules', 'vite-plus')
    const content = await sandbox.file(join(store, `${version.replaceAll('+', '_')}-index.js`), 'shared content')
    await sandbox.directory(virtual)
    await link(content, join(sandbox.root, virtual, 'index.js'))
    await symlink(join(sandbox.root, virtual), join(sandbox.root, release, 'node_modules', 'vite-plus'), 'junction')
    return binary
}

async function select(version: string, root = legacyHome): Promise<void> {
    await symlink(join(sandbox.root, root, version), join(sandbox.root, root, 'current'), 'junction')
}

const cleaner = (
    listProcesses = quietProcesses,
    environment: Record<string, string> = {},
    isInstallLocked: (lockPath: string) => Promise<boolean> = unlocked
): VitePlusInstallationCleaner => new VitePlusInstallationCleaner(sandbox.paths, environment, listProcesses, isInstallLocked)
const names = async (instance = cleaner()): Promise<string[]> => (await instance.detect()).map((candidate) => candidate.displayName).toSorted()

async function firstCandidate(instance: VitePlusInstallationCleaner): Promise<Awaited<ReturnType<VitePlusInstallationCleaner['detect']>>[number]> {
    const [candidate] = await instance.detect()
    if (!candidate) throw new Error('Expected a candidate.')
    return candidate
}

describe('Vite+ releases', () => {
    test('offers superseded releases and preserves the active release, the recorded fallback, and newer releases', async () => {
        for (const version of ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0']) await addRelease(version)
        await select('0.4.0')
        await sandbox.file(join(legacyHome, '.previous-version'), '0.3.0\n')

        expect(await names()).toEqual(['Vite+ 0.1.0', 'Vite+ 0.2.0'])
    })

    test('offers every older release when no fallback is recorded', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')

        expect(await names()).toEqual(['Vite+ 0.1.0'])
    })

    test('measures a release without counting content shared with the pnpm store', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')

        const [candidate] = await cleaner().detect()
        expect(candidate?.sizeBytes).toBe(Buffer.byteLength(JSON.stringify({ name: 'vp-global', version: '0.1.0' })) + 1)
    })

    test('offers nothing unless the active release is verified', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        expect(await names()).toEqual([])

        await select('0.2.0')
        await writeFile(join(sandbox.root, legacyHome, '0.2.0', 'package.json'), JSON.stringify({ version: '0.9.9' }))
        expect(await names()).toEqual([])
    })

    test('offers nothing when the recorded fallback cannot be verified', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        await sandbox.file(join(legacyHome, '.previous-version'), 'not-a-version')
        expect(await names()).toEqual([])
    })

    test('skips releases whose manifest does not verify, and releases in use', async () => {
        await addRelease('0.1.0', legacyHome, '0.0.9')
        const used = await addRelease('0.2.0')
        await addRelease('0.3.0')
        await addRelease('0.4.0')
        await select('0.4.0')
        const running = async (): Promise<WindowsProcess[]> => [{ id: 7, name: 'vp.exe', path: used, commandLine: null }]

        expect(await names(cleaner(running))).toEqual(['Vite+ 0.3.0'])
    })

    test('treats forced-reinstall directories as releases and preserves them when active or recorded', async () => {
        await addRelease('0.1.0+force.100.200')
        await addRelease('0.2.0+force.101.201')
        await addRelease('0.3.0+force.102.202')
        await addRelease('0.4.0+force.103.203')
        await select('0.4.0+force.103.203')
        await sandbox.file(join(legacyHome, '.previous-version'), '0.3.0+force.102.202')

        expect(await names()).toEqual(['Vite+ 0.1.0+force.100.200', 'Vite+ 0.2.0+force.101.201'])
    })
})

describe('Vite+ process and installer guards', () => {
    test('offers nothing when running processes cannot be listed', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        expect(await names(cleaner(() => Promise.reject(new Error('unavailable'))))).toEqual([])
    })

    test('offers nothing when a Vite+ process has no readable path, such as an elevated vp', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')

        expect(await names(cleaner(elevated))).toEqual([])
    })

    test('offers nothing while the Vite+ installer holds its lock', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const lockPaths: string[] = []
        const recording = async (path: string): Promise<boolean> => {
            lockPaths.push(path)
            return true
        }

        expect(await names(cleaner(quietProcesses, {}, recording))).toEqual([])
        expect(lockPaths).toEqual([join(sandbox.root, legacyHome, '.install.lock')])
    })
})

describe('Vite+ data directory', () => {
    test('finds releases in the split data directory used since Vite+ 0.3.0', async () => {
        await addRelease('0.5.0', splitData)
        await addRelease('0.6.0', splitData)
        await select('0.6.0', splitData)

        expect(await names()).toEqual(['Vite+ 0.5.0'])
    })

    test('prefers an existing ~\\.vite-plus install, which Vite+ reuses over the split layout', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        await addRelease('0.5.0', splitData)
        await addRelease('0.6.0', splitData)
        await select('0.6.0', splitData)

        expect(await names()).toEqual(['Vite+ 0.1.0'])
    })

    test('ignores ~\\.vite-plus without a current link', async () => {
        await addRelease('0.1.0')
        await addRelease('0.5.0', splitData)
        await addRelease('0.6.0', splitData)
        await select('0.6.0', splitData)

        expect(await names()).toEqual(['Vite+ 0.5.0'])
    })

    test('honors VP_HOME over every other location', async () => {
        const custom = join('Users', 'test', 'tools', 'vp')
        await addRelease('0.1.0', custom)
        await addRelease('0.2.0', custom)
        await select('0.2.0', custom)
        await addRelease('0.5.0', splitData)
        await addRelease('0.6.0', splitData)
        await select('0.6.0', splitData)

        expect(await names(cleaner(quietProcesses, { VP_HOME: join(sandbox.root, custom) }))).toEqual(['Vite+ 0.1.0'])
    })

    test('honors the VP_BIN_DIR, VP_DATA_DIR, VP_CACHE_DIR group only when all three are set', async () => {
        const custom = join('Users', 'test', 'vp-data')
        await addRelease('0.1.0', custom)
        await addRelease('0.2.0', custom)
        await select('0.2.0', custom)
        const group = { VP_BIN_DIR: join(sandbox.root, custom, 'bin'), VP_DATA_DIR: join(sandbox.root, custom), VP_CACHE_DIR: join(sandbox.root, 'cache') }

        expect(await names(cleaner(quietProcesses, group))).toEqual(['Vite+ 0.1.0'])
        expect(await names(cleaner(quietProcesses, { VP_DATA_DIR: group.VP_DATA_DIR }))).toEqual([])
    })
})

describe('Vite+ removal', () => {
    test('removes a pnpm-style release without touching the store, the other releases, or what links point to', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const outside = await sandbox.file(join('Users', 'test', 'elsewhere', 'keep.txt'), 'keep')
        await symlink(join(sandbox.root, 'Users', 'test', 'elsewhere'), join(sandbox.root, legacyHome, '0.1.0', 'node_modules', 'elsewhere'), 'junction')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await instance.remove(candidate, noop)

        expect(await pathExists(join(sandbox.root, legacyHome, '0.1.0'))).toBe(false)
        expect(await readFile(join(sandbox.root, store, '0.1.0-index.js'), 'utf8')).toBe('shared content')
        expect(await readFile(outside, 'utf8')).toBe('keep')
        expect(await pathExists(join(sandbox.root, legacyHome, '0.2.0', 'bin', 'vp.exe'))).toBe(true)
        expect(await readFile(join(sandbox.root, legacyHome, '0.2.0', 'node_modules', 'vite-plus', 'index.js'), 'utf8')).toBe('shared content')
    })

    test('refuses removal when the release became the recorded fallback', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await sandbox.file(join(legacyHome, '.previous-version'), '0.1.0')

        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '0.1.0'))).toBe(true)
    })

    test('refuses removal when the release became active', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await rmdir(join(sandbox.root, legacyHome, 'current'))
        await select('0.1.0')

        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '0.1.0'))).toBe(true)
    })

    test('refuses removal when the release started running or a Vite+ process path cannot be read', async () => {
        const used = await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const candidate = await firstCandidate(cleaner())
        const running = async (): Promise<WindowsProcess[]> => [{ id: 7, name: 'vp.exe', path: used, commandLine: null }]

        expect(await rejection(cleaner(running).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await rejection(cleaner(elevated).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(used)).toBe(true)
    })

    test('refuses removal while the Vite+ installer holds its lock', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const candidate = await firstCandidate(cleaner())

        expect(await rejection(cleaner(quietProcesses, {}, held).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '0.1.0'))).toBe(true)
    })
})
