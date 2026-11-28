import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rename, rmdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import { addVitePlusRelease, selectVitePlusRelease, vitePlusLegacyHome as legacyHome } from '../../test-support/vite-plus-fixtures.ts'
import type { WindowsProcess } from '../../windows/processes.ts'
import { VitePlusInstallationCleaner } from './vite-plus-cleaner.ts'
import { acquireInstallLock } from './vite-plus-install-lock.ts'

let sandbox: Sandbox
const quietProcesses = async (): Promise<WindowsProcess[]> => [{ id: 4, name: 'System', path: null, commandLine: null }]
const noop = { onRemoved: async (): Promise<void> => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

const add = (version: string, root = legacyHome): Promise<string> => addVitePlusRelease(sandbox, version, root)
const select = (version: string, root = legacyHome): Promise<void> => selectVitePlusRelease(sandbox, version, root)
const names = async (instance: VitePlusInstallationCleaner): Promise<string[]> => (await instance.detect()).map((candidate) => candidate.displayName).toSorted()
// The real lock, so the pin that holds it is what the fixtures try to defeat.
const real = (listProcesses = quietProcesses): VitePlusInstallationCleaner => new VitePlusInstallationCleaner(sandbox.paths, {}, listProcesses, acquireInstallLock)

async function storeWithLock(): Promise<void> {
    await add('1.7.0')
    await add('1.8.0')
    await select('1.8.0')
    await sandbox.file(join(legacyHome, '.install.lock'), '')
}

describe('Vite+ pinned store and lock', () => {
    test('keeps the live lock file bound to its path while releases are inspected, so it cannot be replaced', async () => {
        await storeWithLock()
        const lock = join(sandbox.root, legacyHome, '.install.lock')
        let renameBlocked = false
        // The process inventory runs after the metadata was read, which is when a replacement would matter.
        const inventory = async (): Promise<WindowsProcess[]> => {
            renameBlocked = (await rejection(rename(lock, `${lock}.aside`))) instanceof Error
            return quietProcesses()
        }

        expect(await names(real(inventory))).toEqual(['Vite+ 1.7.0'])
        expect(renameBlocked).toBe(true)
        expect(await pathExists(`${lock}.aside`)).toBe(false)
    })

    test('keeps the live lock file bound to its path through removal', async () => {
        await storeWithLock()
        const lock = join(sandbox.root, legacyHome, '.install.lock')
        const [candidate] = await real().detect()
        if (!candidate) throw new Error('Expected a candidate.')
        let renameBlocked = false
        const inventory = async (): Promise<WindowsProcess[]> => {
            renameBlocked = (await rejection(rename(lock, `${lock}.aside`))) instanceof Error
            return quietProcesses()
        }

        await real(inventory).remove(candidate, noop)

        expect(renameBlocked).toBe(true)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0'))).toBe(false)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.8.0', 'bin', 'vp.exe'))).toBe(true)
    })

    test('keeps the store bound to its path, so it cannot be renamed and another store put in its place', async () => {
        await storeWithLock()
        const store = join(sandbox.root, legacyHome)
        let renameBlocked = false
        const inventory = async (): Promise<WindowsProcess[]> => {
            renameBlocked = (await rejection(rename(store, `${store}-moved`))) instanceof Error
            return quietProcesses()
        }

        await real(inventory).detect()

        expect(renameBlocked).toBe(true)
        expect(await pathExists(`${store}-moved`)).toBe(false)
    })
})

describe('Vite+ fallback that is a link', () => {
    test('protects the release a linked fallback marker really reaches', async () => {
        await add('1.7.0')
        await add('1.8.0')
        await select('1.8.0')
        await sandbox.file(join(legacyHome, '.previous-version'), '1.7.1')
        await symlink(join(sandbox.root, legacyHome, '1.7.0'), join(sandbox.root, legacyHome, '1.7.1'), 'junction')
        await sandbox.file(join(legacyHome, '.install.lock'), '')

        expect(await names(real())).toEqual([])
    })

    test('refuses the store when a linked fallback resolves outside it', async () => {
        await add('1.6.9')
        await add('1.7.0')
        await add('1.8.0')
        await select('1.8.0')
        const outside = await sandbox.directory(join('Users', 'test', 'outside'))
        await sandbox.file(join(legacyHome, '.previous-version'), '1.7.1')
        await symlink(outside, join(sandbox.root, legacyHome, '1.7.1'), 'junction')
        await sandbox.file(join(legacyHome, '.install.lock'), '')

        expect(await names(real())).toEqual([])
    })

    test('treats a fallback that names a missing directory as only that name', async () => {
        await add('1.6.0')
        await add('1.7.0')
        await add('1.8.0')
        await select('1.8.0')
        await sandbox.file(join(legacyHome, '.previous-version'), '1.7.1')
        await sandbox.file(join(legacyHome, '.install.lock'), '')

        expect(await names(real())).toEqual(['Vite+ 1.6.0', 'Vite+ 1.7.0'])
    })

    test('revalidates a fallback that became a link to the release at removal time', async () => {
        await storeWithLock()
        const [candidate] = await real().detect()
        if (!candidate) throw new Error('Expected a candidate.')
        await sandbox.file(join(legacyHome, '.previous-version'), '1.7.1')
        await symlink(join(sandbox.root, legacyHome, '1.7.0'), join(sandbox.root, legacyHome, '1.7.1'), 'junction')

        expect(await rejection(real().remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, legacyHome, '1.7.0', 'bin', 'vp.exe'))).toBe(true)
    })
})

// An external Node whose command line names the release by the logical ~/.vite-plus spelling.
const nodeNaming = (path: string) => async (): Promise<WindowsProcess[]> => [{ id: 31, name: 'node.exe', path: 'C:\\Tools\\node.exe', commandLine: `node.exe "${path}"` }]

describe('Vite+ command lines through a relocated install', () => {
    const relocated = join('Users', 'test', 'relocated')
    async function relocatedStore(): Promise<void> {
        await add('1.7.0', relocated)
        await add('1.8.0', relocated)
        await select('1.8.0', relocated)
        await sandbox.file(join(relocated, '.install.lock'), '')
        await symlink(join(sandbox.root, relocated), join(sandbox.root, legacyHome), 'junction')
    }

    test('skips a release named by the logical path of a relocated ~/.vite-plus', async () => {
        await relocatedStore()
        const logical = join(sandbox.root, legacyHome, '1.7.0', 'dist', 'bin.js')
        const physical = join(sandbox.root, relocated, '1.7.0', 'dist', 'bin.js')

        expect(await names(real(nodeNaming(logical)))).toEqual([])
        expect(await names(real(nodeNaming(physical)))).toEqual([])
        expect(await names(real(quietProcesses))).toEqual(['Vite+ 1.7.0'])
    })

    test('refuses removal when the logical or physical path is named at removal time', async () => {
        await relocatedStore()
        const [candidate] = await real().detect()
        if (!candidate) throw new Error('Expected a candidate.')
        const logical = join(sandbox.root, legacyHome, '1.7.0', 'dist', 'bin.js')
        const physical = join(sandbox.root, relocated, '1.7.0', 'dist', 'bin.js')

        expect(await rejection(real(nodeNaming(logical)).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await rejection(real(nodeNaming(physical)).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, relocated, '1.7.0'))).toBe(true)

        await real().remove(candidate, noop)
        expect(await pathExists(join(sandbox.root, relocated, '1.7.0'))).toBe(false)
        await rmdir(join(sandbox.root, legacyHome))
    })
})

// A runtime started before an update keeps loading files from the release it started in, but names only the link.
const naming =
    (commandLine: string, path = 'C:/Tools/node.exe') =>
    async (): Promise<WindowsProcess[]> => [{ id: 32, name: 'node.exe', path, commandLine }]
const script = (home: string): string => join(sandbox.root, home, 'current', 'node_modules', 'vite-plus', 'dist', 'bin.js')

describe('Vite+ processes that started through current', () => {
    const relocated = join('Users', 'test', 'relocated')

    async function updatedStore(): Promise<void> {
        await add('1.7.0', relocated)
        await add('1.8.0', relocated)
        await select('1.8.0', relocated)
        await sandbox.file(join(relocated, '.install.lock'), '')
        await symlink(join(sandbox.root, relocated), join(sandbox.root, legacyHome), 'junction')
    }

    test('offers nothing for the store while a runtime names its current link, by any spelling', async () => {
        await updatedStore()

        expect(await names(real(naming(`node.exe "${script(legacyHome)}"`)))).toEqual([])
        expect(await names(real(naming(`node.exe "${script(relocated)}"`)))).toEqual([])
        expect(await names(real(naming(`node.exe "${script(legacyHome).replaceAll('\\', '/')}"`)))).toEqual([])
        expect(await names(real(naming('node.exe unrelated.js')))).toEqual(['Vite+ 1.7.0'])
    })

    test('offers nothing while a process runs from the current link by image path', async () => {
        await updatedStore()
        const image = join(sandbox.root, legacyHome, 'current', 'bin', 'vp.exe')
        const vp = async (): Promise<WindowsProcess[]> => [{ id: 33, name: 'vp.exe', path: image, commandLine: null }]

        expect(await names(real(vp))).toEqual([])
    })

    test('refuses removal when such a process is running at removal time, and removes once it has exited', async () => {
        await updatedStore()
        const [candidate] = await real().detect()
        if (!candidate) throw new Error('Expected a candidate.')

        expect(await rejection(real(naming(`node.exe "${script(legacyHome)}"`)).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, relocated, '1.7.0', 'bin', 'vp.exe'))).toBe(true)

        await real().remove(candidate, noop)
        expect(await pathExists(join(sandbox.root, relocated, '1.7.0'))).toBe(false)
    })
})
