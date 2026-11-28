import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link, lstat, mkdir, readFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import type { RemovedEntry } from '../types.ts'
import { removeTreeAnchored } from './anchored-delete.ts'
import { createFilesystemCandidate, pathExists, removeFilesystemCandidate } from './index.ts'

let sandbox: Sandbox
const apps = join('Users', 'test', 'tool')
const release = join(apps, '1.0.0')

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

/** A pnpm-style release: an internal junction and a file hardlinked into a store outside the release. */
async function pnpmRelease(): Promise<{ outside: string; store: string }> {
    await sandbox.file(join(release, 'package.json'), '{}')
    await sandbox.file(join(release, 'node_modules', '.pnpm', 'pkg@1', 'node_modules', 'pkg', 'index.js'), 'module')
    await symlink(join(sandbox.root, release, 'node_modules', '.pnpm', 'pkg@1', 'node_modules', 'pkg'), join(sandbox.root, release, 'node_modules', 'pkg'), 'junction')
    const store = await sandbox.file(join('Users', 'test', 'store', 'content'), 'shared content')
    await link(store, join(sandbox.root, release, 'node_modules', 'shared.js'))
    return { outside: await sandbox.directory(join('Users', 'test', 'elsewhere')), store }
}

const candidateOptions = () => ({
    id: 'tool:release:1.0.0',
    path: join(sandbox.root, release),
    allowedRoot: join(sandbox.root, apps),
    displayName: 'Tool 1.0.0',
    reason: 'test',
    type: 'directory' as const
})

describe('links inside a verified tree', () => {
    test('are rejected by default, so a pnpm-style release is not a candidate', async () => {
        await pnpmRelease()
        expect(await createFilesystemCandidate(candidateOptions())).toBeNull()
    })

    test('are measured without being followed when the cleaner opts in', async () => {
        await pnpmRelease()
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')

        // package.json (2 bytes) and index.js (6 bytes). The hardlinked file is shared with the store.
        expect(candidate.sizeBytes).toBe(8)
    })

    test('are removed without following them or touching what they point to', async () => {
        const { outside, store } = await pnpmRelease()
        await sandbox.file(join('Users', 'test', 'elsewhere', 'keep.txt'), 'keep')
        await symlink(outside, join(sandbox.root, release, 'node_modules', 'out'), 'junction')
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')
        const removed: RemovedEntry[] = []

        await removeFilesystemCandidate(candidate, { onRemoved: async (entry) => void removed.push(entry) })

        expect(await pathExists(join(sandbox.root, release))).toBe(false)
        expect(await readdir(outside)).toEqual(['keep.txt'])
        expect(await readFile(store, 'utf8')).toBe('shared content')
        expect(removed.filter((entry) => entry.kind === 'link').map((entry) => entry.path.split('\\').at(-1))).toEqual(expect.arrayContaining(['pkg', 'out']))
    })

    test('never let a directory swapped for a link after detection redirect removal', async () => {
        await sandbox.file(join(release, 'package.json'), '{}')
        await sandbox.file(join(release, 'node_modules', 'lib', 'a.js'), 'a')
        const outside = await sandbox.file(join('Users', 'test', 'elsewhere', 'precious.txt'), 'precious')
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')

        await rm(join(sandbox.root, release, 'node_modules', 'lib'), { recursive: true })
        await symlink(join(sandbox.root, 'Users', 'test', 'elsewhere'), join(sandbox.root, release, 'node_modules', 'lib'), 'junction')
        await removeFilesystemCandidate(candidate, { onRemoved: async () => {} })

        expect(await readFile(outside, 'utf8')).toBe('precious')
        expect(await pathExists(join(sandbox.root, release))).toBe(false)
    })

    test('never allow the candidate itself to be a link', async () => {
        const target = await sandbox.directory(join('Users', 'test', 'elsewhere'))
        await mkdir(join(sandbox.root, apps), { recursive: true })
        await symlink(target, join(sandbox.root, release), 'junction')

        expect(await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })).toBeNull()
    })

    test('never unlink an entry outside the tree when a containing directory is replaced during removal', async () => {
        await sandbox.file(join(release, 'package.json'), '{}')
        await sandbox.file(join(release, 'node_modules', 'one'), '1')
        const inside = await sandbox.directory(join(release, 'node_modules', 'inside'))
        await symlink(inside, join(sandbox.root, release, 'node_modules', 'two'), 'junction')
        // The directory that will be swapped in holds its own `two` link and file, which are not part of the tree.
        const elsewhere = await sandbox.directory(join('Users', 'test', 'elsewhere'))
        const kept = await sandbox.file(join('Users', 'test', 'kept', 'data.txt'), 'kept')
        await symlink(join(sandbox.root, 'Users', 'test', 'kept'), join(elsewhere, 'two'), 'junction')
        await sandbox.file(join('Users', 'test', 'elsewhere', 'three'), '3')
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')
        let swapped = false

        const failure = await rejection(
            removeFilesystemCandidate(candidate, {
                onRemoved: async (entry) => {
                    if (swapped || !entry.path.endsWith('one')) return
                    swapped = true
                    const modules = join(sandbox.root, release, 'node_modules')
                    await rename(modules, join(sandbox.root, release, 'moved'))
                    await symlink(elsewhere, modules, 'junction')
                }
            })
        )

        expect(swapped).toBe(true)
        expect(failure).toBeInstanceOf(Error)
        expect((await readdir(elsewhere)).toSorted()).toEqual(['three', 'two'])
        expect(await readFile(kept, 'utf8')).toBe('kept')
    })

    test('pin a directory that is being emptied, so a plain directory cannot be swapped into its place', async () => {
        await sandbox.file(join(release, 'package.json'), '{}')
        await sandbox.file(join(release, 'node_modules', 'one'), '1')
        await sandbox.file(join(release, 'node_modules', 'two'), '2')
        // A different plain directory, with an entry of the same name, prepared outside the tree.
        const impostor = await sandbox.file(join('Users', 'test', 'impostor', 'two'), 'impostor')
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')
        let swapBlocked = false
        let swapped = false

        const failure = await rejection(
            removeFilesystemCandidate(candidate, {
                onRemoved: async (entry) => {
                    if (swapped || swapBlocked || !entry.path.endsWith('one')) return
                    const modules = join(sandbox.root, release, 'node_modules')
                    try {
                        await rename(modules, join(sandbox.root, release, 'moved'))
                        await rename(join(sandbox.root, 'Users', 'test', 'impostor'), modules)
                        swapped = true
                    } catch {
                        swapBlocked = true
                    }
                }
            })
        )

        // Windows refuses to rename a directory while the walk holds it open. If it ever did not, removal must still stop.
        expect(swapBlocked || (swapped && failure instanceof Error)).toBe(true)
        if (swapBlocked) expect(failure).toBeNull()
        else expect(await readFile(join(sandbox.root, release, 'node_modules', 'two'), 'utf8')).toBe('impostor')
        expect(swapBlocked ? true : await pathExists(impostor)).toBe(true)
    })

    test('refuse a root that is not the directory that was detected', async () => {
        await sandbox.file(join(release, 'package.json'), '{}')
        const root = join(sandbox.root, release)
        const detected = await lstat(root, { bigint: true })
        // A different plain directory now stands at the same location, as after a swap between detection and removal.
        await rename(root, join(sandbox.root, apps, 'moved'))
        await sandbox.file(join(release, 'keep.txt'), 'keep')

        const failure = await rejection(removeTreeAnchored(root, root, { dev: detected.dev, ino: detected.ino }, { onRemoved: async () => {} }))

        expect(failure).toBeInstanceOf(Error)
        expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep')
    })

    test('release every handle after a failed walk, so the tree can be removed afterwards', async () => {
        await sandbox.file(join(release, 'package.json'), '{}')
        await sandbox.file(join(release, 'sub', 'file.txt'), 'x')
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')

        const failure = await rejection(
            removeFilesystemCandidate(candidate, {
                onRemoved: async () => {
                    throw new Error('stop')
                }
            })
        )
        expect(failure).toBeInstanceOf(Error)

        await rm(join(sandbox.root, release), { recursive: true })
        expect(await pathExists(join(sandbox.root, release))).toBe(false)
    })

    test('keep a checked directory from being renamed out of the tree while its contents are removed', async () => {
        await sandbox.file(join(release, 'package.json'), '{}')
        await sandbox.file(join(release, 'sub', 'a'), 'a')
        await sandbox.file(join(release, 'sub', 'b'), 'b')
        const outside = join(sandbox.root, 'Users', 'test', 'outside')
        await mkdir(outside, { recursive: true })
        const candidate = await createFilesystemCandidate({ ...candidateOptions(), unlinkTreeLinks: true })
        if (!candidate) throw new Error('Expected a candidate.')
        let renameBlocked = false

        await removeFilesystemCandidate(candidate, {
            onRemoved: async (entry) => {
                if (!entry.path.endsWith('a')) return
                // The directory being emptied is checked and open, so it cannot be moved out and finished elsewhere.
                renameBlocked = (await rejection(rename(join(sandbox.root, release, 'sub'), join(outside, 'sub')))) instanceof Error
            }
        })

        expect(renameBlocked).toBe(true)
        expect(await readdir(outside)).toEqual([])
        expect(await pathExists(join(sandbox.root, release))).toBe(false)
    })
})
