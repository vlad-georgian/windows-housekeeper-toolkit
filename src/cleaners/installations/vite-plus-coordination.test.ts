import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import { addVitePlusRelease, selectVitePlusRelease, vitePlusLegacyHome as legacyHome, vitePlusSplitData as splitData } from '../../test-support/vite-plus-fixtures.ts'
import type { WindowsProcess } from '../../windows/processes.ts'
import { VitePlusInstallationCleaner } from './vite-plus-cleaner.ts'
import { acquireInstallLock, type InstallLockAcquirer } from './vite-plus-install-lock.ts'

let sandbox: Sandbox
const quietProcesses = async (): Promise<WindowsProcess[]> => [{ id: 4, name: 'System', path: null, commandLine: null }]
const free: InstallLockAcquirer = async () => () => {}
const noop = { onRemoved: async (): Promise<void> => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

const add = (version: string, root = legacyHome): Promise<string> => addVitePlusRelease(sandbox, version, root)
const select = (version: string, root = legacyHome): Promise<void> => selectVitePlusRelease(sandbox, version, root)
const cleaner = (listProcesses = quietProcesses, acquireLock: InstallLockAcquirer = free): VitePlusInstallationCleaner =>
    new VitePlusInstallationCleaner(sandbox.paths, {}, listProcesses, acquireLock)
const names = async (instance = cleaner()): Promise<string[]> => (await instance.detect()).map((candidate) => candidate.displayName).toSorted()

async function firstCandidate(instance: VitePlusInstallationCleaner): Promise<Awaited<ReturnType<VitePlusInstallationCleaner['detect']>>[number]> {
    const [candidate] = await instance.detect()
    if (!candidate) throw new Error('Expected a candidate.')
    return candidate
}

const node = (commandLine: string | null) => async (): Promise<WindowsProcess[]> => [{ id: 30, name: 'node.exe', path: 'C:\\Tools\\node.exe', commandLine }]

const release = (): string => join(sandbox.root, legacyHome, '1.7.0')
const held: InstallLockAcquirer = async () => null
const wrapper = (version: string, name: string, dependencies: object): string => JSON.stringify({ name, version, private: true, dependencies })

async function splitInstall(): Promise<void> {
    await add('1.11.0', splitData)
    await add('1.12.0', splitData)
    await select('1.12.0', splitData)
}

async function twoReleases(): Promise<void> {
    await add('1.7.0')
    await add('1.8.0')
    await select('1.8.0')
}

describe('Vite+ installer coordination', () => {
    test('offers nothing for a Vite+ whose updater does not take the installation lock', async () => {
        await add('1.5.0')
        await add('1.6.0')
        await select('1.6.0')

        expect(await names()).toEqual([])
    })

    test('offers nothing without a real lock file, and never creates one', async () => {
        await twoReleases()

        expect(await names(cleaner(quietProcesses, acquireInstallLock))).toEqual([])
        expect(await pathExists(join(sandbox.root, legacyHome, '.install.lock'))).toBe(false)
    })

    test('holds the real lock while it detects and releases it afterwards', async () => {
        await twoReleases()
        const lockPath = await sandbox.file(join(legacyHome, '.install.lock'), '')
        let heldDuringDetection = false
        const inspecting = async (): Promise<WindowsProcess[]> => {
            heldDuringDetection = (await acquireInstallLock(lockPath)) === null
            return quietProcesses()
        }

        expect(await names(cleaner(inspecting, acquireInstallLock))).toEqual(['Vite+ 1.7.0'])
        expect(heldDuringDetection).toBe(true)
        const again = await acquireInstallLock(lockPath)
        expect(again).not.toBeNull()
        again?.()
    })

    test('reads the selection only after taking the lock, so a rollback that finished first is seen', async () => {
        await twoReleases()
        const candidate = await firstCandidate(cleaner())
        // A rollback holds the lock, makes 1.7.0 current and records 1.8.0 as the fallback, then releases it.
        const afterRollback: InstallLockAcquirer = async () => {
            await rmdir(join(sandbox.root, legacyHome, 'current'))
            await select('1.7.0')
            await writeFile(join(sandbox.root, legacyHome, '.previous-version'), '1.8.0')
            return () => {}
        }

        expect(await rejection(cleaner(quietProcesses, afterRollback).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0', 'bin', 'vp.exe'))).toBe(true)
    })

    test('refuses removal while the installer holds the lock', async () => {
        await twoReleases()
        const candidate = await firstCandidate(cleaner())

        expect(await rejection(cleaner(quietProcesses, held).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0'))).toBe(true)
    })

    test('releases the lock after every refusal and after a removal', async () => {
        await twoReleases()
        const candidate = await firstCandidate(cleaner())
        let releases = 0
        const counting: InstallLockAcquirer = async () => () => void (releases += 1)
        await sandbox.file(join(legacyHome, '.previous-version'), '1.7.0')

        expect(await rejection(cleaner(quietProcesses, counting).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(releases).toBe(1)

        await rm(join(sandbox.root, legacyHome, '.previous-version'))
        await cleaner(quietProcesses, counting).remove(candidate, noop)
        expect(releases).toBe(2)
    })
})

describe('Vite+ release identity and order', () => {
    test('treats a fallback marker that differs only in case as the same release', async () => {
        await add('1.7.0')
        await add('1.8.0-rc.1')
        await add('1.9.0')
        await select('1.9.0')
        await sandbox.file(join(legacyHome, '.previous-version'), '1.8.0-RC.1')

        expect(await names()).toEqual(['Vite+ 1.7.0'])
    })

    test('orders prereleases by SemVer precedence, so a final release is newer than its active prerelease', async () => {
        await add('1.7.0')
        await add('1.8.0-beta.2')
        await add('1.8.0-rc.1')
        await add('1.8.0')
        await select('1.8.0-rc.1')

        expect(await names()).toEqual(['Vite+ 1.7.0', 'Vite+ 1.8.0-beta.2'])
    })

    test('offers only directories holding the installer wrapper project', async () => {
        await twoReleases()
        await add('1.9.0')
        await rmdir(join(sandbox.root, legacyHome, 'current'))
        await select('1.9.0')
        await sandbox.file(join(legacyHome, '1.7.5', 'package.json'), wrapper('1.7.5', 'some-other-app', { 'vite-plus': '1.7.5' }))
        await sandbox.file(join(legacyHome, '1.7.6', 'package.json'), wrapper('1.7.6', 'vp-global', {}))
        await sandbox.file(join(legacyHome, '1.7.7', 'package.json'), wrapper('1.7.7', 'vp-global', { 'vite-plus': '9.9.9' }))

        expect(await names()).toEqual(['Vite+ 1.7.0', 'Vite+ 1.8.0'])
    })
})

describe('Vite+ script runtimes', () => {
    test('skips a release that an external Node runs a script from', async () => {
        await twoReleases()

        expect(await names(cleaner(node(`node.exe "${release()}\\node_modules\\vite-plus\\dist\\bin.js" check`)))).toEqual([])
        expect(await names(cleaner(node('node.exe C:\\work\\unrelated.js')))).toEqual(['Vite+ 1.7.0'])
    })

    test('offers nothing when a runtime command line is withheld, as it cannot be told from a Vite+ child', async () => {
        await twoReleases()

        expect(await names(cleaner(node(null)))).toEqual([])
    })

    test('refuses removal when a runtime started running from the release', async () => {
        await twoReleases()
        const candidate = await firstCandidate(cleaner())

        expect(await rejection(cleaner(node(`node.exe "${release()}\\bin.js"`)).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(release())).toBe(true)
    })
})

describe('Vite+ legacy directory ambiguity', () => {
    test('does not fall back to the split layout when ~\\.vite-plus is not a directory', async () => {
        await splitInstall()
        await sandbox.file(legacyHome, 'not a directory')

        expect(await names()).toEqual([])
    })

    test('does not fall back to the split layout when ~\\.vite-plus is a dangling link', async () => {
        await splitInstall()
        const target = await sandbox.directory(join('Users', 'test', 'gone'))
        await symlink(target, join(sandbox.root, legacyHome), 'junction')
        await rm(target, { recursive: true })

        expect(await names()).toEqual([])
    })

    test('uses a legacy directory reached through a link, as a relocated install is', async () => {
        const target = join('Users', 'test', 'relocated')
        await add('1.7.0', target)
        await add('1.8.0', target)
        await select('1.8.0', target)
        await symlink(join(sandbox.root, target), join(sandbox.root, legacyHome), 'junction')

        expect(await names()).toEqual(['Vite+ 1.7.0'])
    })

    test('uses the split layout when ~\\.vite-plus is a directory without a current link', async () => {
        await sandbox.directory(legacyHome)
        await add('1.11.0', splitData)
        await add('1.12.0', splitData)
        await select('1.12.0', splitData)

        expect(await names()).toEqual(['Vite+ 1.11.0'])
    })
})
