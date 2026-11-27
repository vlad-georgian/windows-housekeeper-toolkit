import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, rmdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import type { WindowsProcess } from '../../windows/processes.ts'
import { VitePlusInstallationCleaner } from './vite-plus-cleaner.ts'

let sandbox: Sandbox
const home = join('Users', 'test', '.vite-plus')
const noProcesses = async (): Promise<WindowsProcess[]> => [{ id: 1, name: 'explorer.exe', path: 'C:\\Windows\\explorer.exe', commandLine: null }]

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

async function addRelease(version: string, manifestVersion = version): Promise<string> {
    await sandbox.file(join(home, version, 'package.json'), JSON.stringify({ name: 'vite-plus', version: manifestVersion }))
    return sandbox.file(join(home, version, 'bin', 'vp.exe'))
}

async function select(version: string): Promise<void> {
    await symlink(join(sandbox.root, home, version), join(sandbox.root, home, 'current'), 'junction')
}

const cleaner = (listProcesses = noProcesses, environment: Record<string, string> = {}): VitePlusInstallationCleaner =>
    new VitePlusInstallationCleaner(sandbox.paths, environment, listProcesses)
const names = async (instance = cleaner()): Promise<string[]> => (await instance.detect()).map((candidate) => candidate.displayName).toSorted()
const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
        () => true,
        () => false
    )
const noop = { onRemoved: async (): Promise<void> => {} }

async function firstCandidate(instance: VitePlusInstallationCleaner): Promise<Awaited<ReturnType<VitePlusInstallationCleaner['detect']>>[number]> {
    const [candidate] = await instance.detect()
    if (!candidate) throw new Error('Expected a candidate.')
    return candidate
}

describe('Vite+ releases', () => {
    test('offers superseded releases and preserves the active release, the recorded fallback, and newer releases', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await addRelease('0.3.0')
        await addRelease('0.4.0')
        await addRelease('0.5.0')
        await select('0.4.0')
        await sandbox.file(join(home, '.previous-version'), '0.3.0\n')

        expect(await names()).toEqual(['Vite+ 0.1.0', 'Vite+ 0.2.0'])
    })

    test('offers every older release when no fallback is recorded', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')

        expect(await names()).toEqual(['Vite+ 0.1.0'])
    })

    test('offers nothing unless the active release is verified', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        expect(await names()).toEqual([])

        await select('0.2.0')
        await writeFile(join(sandbox.root, home, '0.2.0', 'package.json'), JSON.stringify({ version: '0.9.9' }))
        expect(await names()).toEqual([])
    })

    test('offers nothing when the recorded fallback cannot be verified', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        await sandbox.file(join(home, '.previous-version'), 'not-a-version')
        expect(await names()).toEqual([])
    })

    test('skips releases whose manifest does not verify, and releases in use', async () => {
        await addRelease('0.1.0', '0.0.9')
        const used = await addRelease('0.2.0')
        await addRelease('0.3.0')
        await addRelease('0.4.0')
        await select('0.4.0')
        const running = async (): Promise<WindowsProcess[]> => [{ id: 7, name: 'vp.exe', path: used, commandLine: null }]

        expect(await names(cleaner(running))).toEqual(['Vite+ 0.3.0'])
    })

    test('offers nothing when running processes cannot be listed', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        expect(await names(cleaner(() => Promise.reject(new Error('unavailable'))))).toEqual([])
    })

    test('honors VP_HOME', async () => {
        const custom = join('Users', 'test', 'tools', 'vp')
        await sandbox.file(join(custom, '0.1.0', 'package.json'), JSON.stringify({ version: '0.1.0' }))
        await sandbox.file(join(custom, '0.2.0', 'package.json'), JSON.stringify({ version: '0.2.0' }))
        await symlink(join(sandbox.root, custom, '0.2.0'), join(sandbox.root, custom, 'current'), 'junction')

        expect(await names(cleaner(noProcesses, { VP_HOME: join(sandbox.root, custom) }))).toEqual(['Vite+ 0.1.0'])
    })

    test('removes a superseded release but nothing else', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const instance = cleaner()

        await instance.remove(await firstCandidate(instance), noop)

        expect(await exists(join(sandbox.root, home, '0.1.0'))).toBe(false)
        expect(await exists(join(sandbox.root, home, '0.2.0', 'bin', 'vp.exe'))).toBe(true)
    })

    test('refuses removal when the release became the recorded fallback', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await sandbox.file(join(home, '.previous-version'), '0.1.0')

        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await exists(join(sandbox.root, home, '0.1.0'))).toBe(true)
    })

    test('refuses removal when the release became active', async () => {
        await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const instance = cleaner()
        const candidate = await firstCandidate(instance)

        await rmdir(join(sandbox.root, home, 'current'))
        await select('0.1.0')

        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await exists(join(sandbox.root, home, '0.1.0'))).toBe(true)
    })

    test('refuses removal when the release started running', async () => {
        const used = await addRelease('0.1.0')
        await addRelease('0.2.0')
        await select('0.2.0')
        const candidate = await firstCandidate(cleaner())
        const running = async (): Promise<WindowsProcess[]> => [{ id: 7, name: 'vp.exe', path: used, commandLine: null }]

        expect(await rejection(cleaner(running).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await exists(used)).toBe(true)
    })
})
