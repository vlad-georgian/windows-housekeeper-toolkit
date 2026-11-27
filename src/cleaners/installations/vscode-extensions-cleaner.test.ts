import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import { VSCodeExtensionsCleaner } from './vscode-extensions-cleaner.ts'

let sandbox: Sandbox
const extensions = join('Users', 'test', '.vscode', 'extensions')
const profiles = join('Users', 'test', 'AppData', 'Roaming', 'Code', 'User', 'profiles')
const noop = { onRemoved: async (): Promise<void> => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

async function addExtension(folder: string): Promise<void> {
    await sandbox.file(join(extensions, folder, 'package.json'), '{}')
}

async function registry(...installed: string[]): Promise<void> {
    await sandbox.file(
        join(extensions, 'extensions.json'),
        JSON.stringify(
            installed.map((folder) => ({
                identifier: { id: folder },
                relativeLocation: folder,
                location: { $mid: 1, path: `/c:/Users/test/.vscode/extensions/${folder}`, scheme: 'file' }
            }))
        )
    )
}

async function obsolete(value: unknown): Promise<void> {
    await sandbox.file(join(extensions, '.obsolete'), JSON.stringify(value))
}

const cleaner = (): VSCodeExtensionsCleaner => new VSCodeExtensionsCleaner(sandbox.paths)
const names = async (): Promise<string[]> => (await cleaner().detect()).map((candidate) => candidate.displayName).toSorted()

describe('obsolete VS Code extensions', () => {
    test('offers only folders the metadata marks obsolete and preserves installed extensions', async () => {
        await addExtension('docker.docker-0.4.1-win32-x64')
        await addExtension('docker.docker-0.19.1-win32-x64')
        await addExtension('eamodio.gitlens-19.5.0')
        await addExtension('stale.unmarked-1.0.0')
        await registry('docker.docker-0.19.1-win32-x64', 'eamodio.gitlens-19.5.0')
        await obsolete({ 'docker.docker-0.4.1-win32-x64': true, 'docker.docker-0.19.1-win32-x64': true })

        expect(await names()).toEqual(['VS Code extension docker.docker-0.4.1-win32-x64'])
    })

    test('ignores obsolete entries that are not marked true, are missing, or are not plain folder names', async () => {
        await addExtension('a.ext-1.0.0')
        await addExtension('b.ext-1.0.0')
        await registry()
        await obsolete({ 'a.ext-1.0.0': false, 'b.ext-1.0.0': 'yes', 'gone.ext-1.0.0': true, '..\\..\\Documents': true, '../x': true })

        expect(await names()).toEqual([])
    })

    test('offers nothing when the metadata or installed-extension registry cannot be read', async () => {
        await addExtension('a.ext-1.0.0')
        await obsolete({ 'a.ext-1.0.0': true })
        expect(await names()).toEqual([])

        await sandbox.file(join(extensions, 'extensions.json'), 'not json')
        expect(await names()).toEqual([])

        await registry()
        await sandbox.file(join(extensions, '.obsolete'), '[1]')
        expect(await names()).toEqual([])
    })

    test('removes an obsolete extension folder only, after revalidating the metadata', async () => {
        await addExtension('a.ext-1.0.0')
        await addExtension('a.ext-2.0.0')
        await registry('a.ext-2.0.0')
        await obsolete({ 'a.ext-1.0.0': true })
        const instance = cleaner()
        const [candidate] = await instance.detect()
        if (!candidate) throw new Error('Expected a candidate.')

        // VS Code reinstalled the extension after detection.
        await registry('a.ext-1.0.0', 'a.ext-2.0.0')
        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, extensions, 'a.ext-1.0.0'))).toBe(true)

        // VS Code dropped the obsolete marker after detection.
        await registry('a.ext-2.0.0')
        await obsolete({})
        expect(await rejection(instance.remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, extensions, 'a.ext-1.0.0'))).toBe(true)

        await obsolete({ 'a.ext-1.0.0': true })
        await instance.remove(candidate, noop)
        expect(await pathExists(join(sandbox.root, extensions, 'a.ext-1.0.0'))).toBe(false)
        expect(await pathExists(join(sandbox.root, extensions, 'a.ext-2.0.0'))).toBe(true)
    })

    test('reads a registry larger than the default small-file limit', async () => {
        await addExtension('a.old-1.0.0')
        await addExtension('a.old-2.0.0')
        const installed = Array.from({ length: 1200 }, (_, index) => `publisher.extension-${index}-1.0.0`)
        await registry('a.old-2.0.0', ...installed)
        await obsolete({ 'a.old-1.0.0': true, 'a.old-2.0.0': true })
        expect((await stat(join(sandbox.root, extensions, 'extensions.json'))).size).toBeGreaterThan(131_072)

        expect(await names()).toEqual(['VS Code extension a.old-1.0.0'])
    })

    test('preserves extensions that any VS Code profile still lists as installed', async () => {
        await addExtension('a.old-1.0.0')
        await addExtension('b.shared-1.0.0')
        await registry()
        await obsolete({ 'a.old-1.0.0': true, 'b.shared-1.0.0': true })
        await sandbox.file(join(profiles, 'work', 'extensions.json'), JSON.stringify([{ relativeLocation: 'b.shared-1.0.0' }]))
        await sandbox.file(join(profiles, 'play', 'extensions.json'), '[]')
        await sandbox.file(join(profiles, 'empty', 'settings.json'), '{}')

        expect(await names()).toEqual(['VS Code extension a.old-1.0.0'])
    })

    test('offers nothing when a profile registry cannot be read', async () => {
        await addExtension('a.old-1.0.0')
        await registry()
        await obsolete({ 'a.old-1.0.0': true })
        await sandbox.file(join(profiles, 'work', 'extensions.json'), 'not json')

        expect(await names()).toEqual([])
    })
})
