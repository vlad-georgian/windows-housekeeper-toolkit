import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, realpath, rmdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import { addVitePlusRelease, pnpmStore, selectVitePlusRelease, vitePlusLegacyHome, vitePlusSplitData } from '../../test-support/vite-plus-fixtures.ts'
import type { WindowsProcess } from '../../windows/processes.ts'
import { VitePlusInstallationCleaner } from './vite-plus-cleaner.ts'
import type { InstallLockAcquirer } from './vite-plus-install-lock.ts'

let sandbox: Sandbox
const legacyHome = vitePlusLegacyHome
const splitData = vitePlusSplitData
const store = pnpmStore
// Windows reports no path for system processes. They cannot be running from a user install.
const quietProcesses = async (): Promise<WindowsProcess[]> => [{ id: 4, name: 'System', path: null, commandLine: null }]
// The lock as the cleaner sees it: free, or held by a Vite+ installer.
const free: InstallLockAcquirer = async () => () => {}
const held: InstallLockAcquirer = async () => null
// Windows hides the path of an elevated process from an unelevated tool.
const elevated = async (): Promise<WindowsProcess[]> => [{ id: 12, name: 'vp.exe', path: null, commandLine: null }]
const noop = { onRemoved: async (): Promise<void> => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

const addRelease = (version: string, root = legacyHome, manifestVersion?: string): Promise<string> => addVitePlusRelease(sandbox, version, root, manifestVersion)
const select = (version: string, root = legacyHome): Promise<void> => selectVitePlusRelease(sandbox, version, root)

const cleaner = (listProcesses = quietProcesses, environment: Record<string, string> = {}, acquireLock: InstallLockAcquirer = free): VitePlusInstallationCleaner =>
    new VitePlusInstallationCleaner(sandbox.paths, environment, listProcesses, acquireLock)
const names = async (instance = cleaner()): Promise<string[]> => (await instance.detect()).map((candidate) => candidate.displayName).toSorted()

async function firstCandidate(instance: VitePlusInstallationCleaner): Promise<Awaited<ReturnType<VitePlusInstallationCleaner['detect']>>[number]> {
    const [candidate] = await instance.detect()
    if (!candidate) throw new Error('Expected a candidate.')
    return candidate
}

describe('Vite+ releases', () => {
    test('offers superseded releases and preserves the active release, the recorded fallback, and newer releases', async () => {
        for (const version of ['1.7.0', '1.8.0', '1.9.0', '1.10.0', '1.11.0']) await addRelease(version)
        await select('1.10.0')
        await sandbox.file(join(legacyHome, '.previous-version'), '1.9.0\n')

        expect(await names()).toEqual(['Vite+ 1.7.0', 'Vite+ 1.8.0'])
    })

    test('offers every older release when no fallback is recorded', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')

        expect(await names()).toEqual(['Vite+ 1.7.0'])
    })

    test('measures a release without counting content shared with the pnpm store', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')

        const [candidate] = await cleaner().detect()
        expect(candidate?.sizeBytes).toBe(Buffer.byteLength(JSON.stringify({ name: 'vp-global', version: '1.7.0', private: true, dependencies: { 'vite-plus': '1.7.0' } })) + 1)
    })

    test('offers nothing unless the active release is verified', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        expect(await names()).toEqual([])

        await select('1.8.0')
        await writeFile(join(sandbox.root, legacyHome, '1.8.0', 'package.json'), JSON.stringify({ version: '0.9.9' }))
        expect(await names()).toEqual([])
    })

    test('offers nothing when the recorded fallback cannot be verified', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        await sandbox.file(join(legacyHome, '.previous-version'), 'not-a-version')
        expect(await names()).toEqual([])
    })

    test('skips releases whose manifest does not verify, and releases in use', async () => {
        await addRelease('1.7.0', legacyHome, '0.0.9')
        const used = await addRelease('1.8.0')
        await addRelease('1.9.0')
        await addRelease('1.10.0')
        await select('1.10.0')
        const running = async (): Promise<WindowsProcess[]> => [{ id: 7, name: 'vp.exe', path: used, commandLine: null }]

        expect(await names(cleaner(running))).toEqual(['Vite+ 1.9.0'])
    })

    test('treats forced-reinstall directories as releases and preserves them when active or recorded', async () => {
        await addRelease('1.7.0+force.100.200')
        await addRelease('1.8.0+force.101.201')
        await addRelease('1.9.0+force.102.202')
        await addRelease('1.10.0+force.103.203')
        await select('1.10.0+force.103.203')
        await sandbox.file(join(legacyHome, '.previous-version'), '1.9.0+force.102.202')

        expect(await names()).toEqual(['Vite+ 1.7.0+force.100.200', 'Vite+ 1.8.0+force.101.201'])
    })
})

describe('Vite+ process and installer guards', () => {
    test('offers nothing when running processes cannot be listed', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        expect(await names(cleaner(() => Promise.reject(new Error('unavailable'))))).toEqual([])
    })

    test('offers nothing when a Vite+ process has no readable path, such as an elevated vp', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')

        expect(await names(cleaner(elevated))).toEqual([])
    })

    test('offers nothing while the Vite+ installer holds its lock', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        const lockPaths: string[] = []
        const recording: InstallLockAcquirer = async (path) => {
            lockPaths.push(path)
            return null
        }

        expect(await names(cleaner(quietProcesses, {}, recording))).toEqual([])
        expect(lockPaths.map((path) => path.toLowerCase())).toEqual([(await realpath(join(sandbox.root, legacyHome))).toLowerCase()])
    })
})

describe('Vite+ data directory', () => {
    test('finds releases in the split data directory used since Vite+ 0.3.0', async () => {
        await addRelease('1.11.0', splitData)
        await addRelease('1.12.0', splitData)
        await select('1.12.0', splitData)

        expect(await names()).toEqual(['Vite+ 1.11.0'])
    })

    test('prefers an existing ~\\.vite-plus install, which Vite+ reuses over the split layout', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        await addRelease('1.11.0', splitData)
        await addRelease('1.12.0', splitData)
        await select('1.12.0', splitData)

        expect(await names()).toEqual(['Vite+ 1.7.0'])
    })

    test('ignores ~\\.vite-plus without a current link', async () => {
        await addRelease('1.7.0')
        await addRelease('1.11.0', splitData)
        await addRelease('1.12.0', splitData)
        await select('1.12.0', splitData)

        expect(await names()).toEqual(['Vite+ 1.11.0'])
    })

    test('honors VP_HOME over every other location', async () => {
        const custom = join('Users', 'test', 'tools', 'vp')
        await addRelease('1.7.0', custom)
        await addRelease('1.8.0', custom)
        await select('1.8.0', custom)
        await addRelease('1.11.0', splitData)
        await addRelease('1.12.0', splitData)
        await select('1.12.0', splitData)

        expect(await names(cleaner(quietProcesses, { VP_HOME: join(sandbox.root, custom) }))).toEqual(['Vite+ 1.7.0'])
    })

    test('honors the VP_BIN_DIR, VP_DATA_DIR, VP_CACHE_DIR group only when all three are set', async () => {
        const custom = join('Users', 'test', 'vp-data')
        await addRelease('1.7.0', custom)
        await addRelease('1.8.0', custom)
        await select('1.8.0', custom)
        const group = { VP_BIN_DIR: join(sandbox.root, custom, 'bin'), VP_DATA_DIR: join(sandbox.root, custom), VP_CACHE_DIR: join(sandbox.root, 'cache') }

        expect(await names(cleaner(quietProcesses, group))).toEqual(['Vite+ 1.7.0'])
        expect(await names(cleaner(quietProcesses, { VP_DATA_DIR: group.VP_DATA_DIR }))).toEqual([])
    })
})

describe('Vite+ removal', () => {
    test('removes a pnpm-style release without touching the store, the other releases, or what links point to', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        const outside = await sandbox.file(join('Users', 'test', 'elsewhere', 'keep.txt'), 'keep')
        await symlink(join(sandbox.root, 'Users', 'test', 'elsewhere'), join(sandbox.root, legacyHome, '1.7.0', 'node_modules', 'elsewhere'), 'junction')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await instance.remove(candidate, noop)

        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0'))).toBe(false)
        expect(await readFile(join(sandbox.root, store, '1.7.0-index.js'), 'utf8')).toBe('shared content')
        expect(await readFile(outside, 'utf8')).toBe('keep')
        expect(await pathExists(join(sandbox.root, legacyHome, '1.8.0', 'bin', 'vp.exe'))).toBe(true)
        expect(await readFile(join(sandbox.root, legacyHome, '1.8.0', 'node_modules', 'vite-plus', 'index.js'), 'utf8')).toBe('shared content')
    })

    test('refuses removal when the release became the recorded fallback', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await sandbox.file(join(legacyHome, '.previous-version'), '1.7.0')

        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0'))).toBe(true)
    })

    test('refuses removal when the release became active', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await rmdir(join(sandbox.root, legacyHome, 'current'))
        await select('1.7.0')

        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0'))).toBe(true)
    })

    test('refuses removal when the release started running or a Vite+ process path cannot be read', async () => {
        const used = await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        const candidate = await firstCandidate(cleaner())
        const running = async (): Promise<WindowsProcess[]> => [{ id: 7, name: 'vp.exe', path: used, commandLine: null }]

        expect(await rejection(cleaner(running).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await rejection(cleaner(elevated).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(used)).toBe(true)
    })

    test('refuses removal while the Vite+ installer holds its lock', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await select('1.8.0')
        const candidate = await firstCandidate(cleaner())

        expect(await rejection(cleaner(quietProcesses, {}, held).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0'))).toBe(true)
    })

    test('offers nothing when fallback data exists but cannot be read, and treats only a missing marker as absent', async () => {
        await addRelease('1.7.0')
        await addRelease('1.8.0')
        await addRelease('1.9.0')
        await select('1.9.0')
        // Absent: nothing recorded, so both older releases are offered.
        expect(await names()).toEqual(['Vite+ 1.7.0', 'Vite+ 1.8.0'])

        // A directory in place of the marker file cannot be read as a fallback.
        await sandbox.directory(join(legacyHome, '.previous-version'))
        expect(await names()).toEqual([])
        await rmdir(join(sandbox.root, legacyHome, '.previous-version'))

        // A marker that denies reads is unreadable too, not absent.
        const marker = await sandbox.file(join(legacyHome, '.previous-version'), '1.8.0')
        Bun.spawnSync(['icacls', marker, '/deny', '*S-1-1-0:(R)'])
        try {
            expect(await names()).toEqual([])
        } finally {
            Bun.spawnSync(['icacls', marker, '/remove:d', '*S-1-1-0'])
        }
    })
})
