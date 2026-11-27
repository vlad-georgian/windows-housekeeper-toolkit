import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readdir, rm, symlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import type { CleanupCandidate, RemovedEntry, SkippedEntry } from '../types.ts'
import { pathExists } from './paths.ts'
import { createContentsCandidate, defaultContentsOperations as defaultOperations, removeContentsCandidate, type ContentsOperations } from './temporary-contents.ts'

let sandbox: Sandbox
let root: string

beforeEach(async () => {
    sandbox = await createSandbox()
    root = sandbox.paths.temp
})
afterEach(() => sandbox.dispose())

async function detect(path = root): Promise<CleanupCandidate | null> {
    return createContentsCandidate({
        id: 'test:contents',
        root: path,
        within: sandbox.paths.home,
        protectedPaths: [sandbox.paths.home, sandbox.paths.localAppData, sandbox.paths.roamingAppData],
        displayName: 'Test contents',
        reason: 'Test'
    })
}

function recorder(): { removed: RemovedEntry[]; skipped: SkippedEntry[]; callbacks: Parameters<typeof removeContentsCandidate>[1] } {
    const removed: RemovedEntry[] = []
    const skipped: SkippedEntry[] = []
    return {
        removed,
        skipped,
        callbacks: {
            onRemoved: async (entry) => {
                removed.push(entry)
            },
            onSkipped: async (entry) => {
                skipped.push(entry)
            }
        }
    }
}

function required<T>(value: T | null): T {
    if (value === null) throw new Error('Expected a candidate.')
    return value
}

describe('temporary directory contents candidate', () => {
    test('offers the directory contents with their size and count', async () => {
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'a.tmp'), '12345')
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'nested', 'b.tmp'), '123')
        const candidate = required(await detect())
        expect(candidate.sizeBytes).toBe(8)
        expect(candidate.fileCount).toBe(2)
    })

    test('offers nothing for an empty or missing directory', async () => {
        expect(await detect()).toBeNull()
        expect(await detect(join(root, 'missing'))).toBeNull()
    })

    test('offers nothing when the directory is outside the allowed location', async () => {
        const machineWide = await sandbox.file(join('Windows', 'Temp', 'a.tmp'))
        expect(machineWide).toContain('Windows')
        expect(await detect(join(sandbox.root, 'Windows', 'Temp'))).toBeNull()
    })

    test('offers nothing when the directory contains the profile', async () => {
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'a.tmp'))
        expect(await detect(sandbox.paths.home)).toBeNull()
        expect(await detect(sandbox.paths.localAppData)).toBeNull()
    })

    test('offers nothing when the directory is a link', async () => {
        const target = await sandbox.file(join('Users', 'test', 'elsewhere', 'a.tmp'))
        expect(target).toContain('elsewhere')
        const link = join(sandbox.paths.localAppData, 'Linked')
        await symlink(join(sandbox.root, 'Users', 'test', 'elsewhere'), link, 'junction')
        expect(await detect(link)).toBeNull()
    })
})

describe('temporary directory contents removal', () => {
    test('removes every entry regardless of age and keeps the directory', async () => {
        const old = await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'old.tmp'), 'old')
        await utimes(old, new Date('2001-01-01'), new Date('2001-01-01'))
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'new.tmp'), 'new!')
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'dir', 'deep', 'c.tmp'), 'c')
        await sandbox.directory(join('Users', 'test', 'AppData', 'Local', 'Temp', 'empty'))
        const { removed, skipped, callbacks } = recorder()

        const result = await removeContentsCandidate(required(await detect()), callbacks)

        expect(await readdir(root)).toEqual([])
        expect(await pathExists(root)).toBe(true)
        expect(skipped).toEqual([])
        expect(result.reclaimedBytes).toBe(3 + 4 + 1)
        expect(removed.filter((entry) => entry.kind === 'file')).toHaveLength(3)
        expect(removed.filter((entry) => entry.kind === 'directory')).toHaveLength(3)
        expect(result.removedEntries).toBe(removed.length)
    })

    test('removes links without following them', async () => {
        const outside = await sandbox.file(join('Users', 'test', 'Documents', 'keep.txt'), 'precious')
        await symlink(join(sandbox.root, 'Users', 'test', 'Documents'), join(root, 'junction'), 'junction')
        await symlink(outside, join(root, 'file-link'), 'file').catch(() => {})
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'plain.tmp'))
        const { removed, skipped, callbacks } = recorder()

        await removeContentsCandidate(required(await detect()), callbacks)

        expect(await readdir(root)).toEqual([])
        expect(skipped).toEqual([])
        expect(await Bun.file(outside).text()).toBe('precious')
        expect(removed.some((entry) => entry.kind === 'link' && entry.path.endsWith('junction'))).toBe(true)
    })

    test('skips entries that cannot be removed and continues with their siblings', async () => {
        const locked = await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'dir', 'locked.tmp'))
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'dir', 'free.tmp'))
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'sibling.tmp'))
        const { removed, skipped, callbacks } = recorder()
        const operations: ContentsOperations = {
            async unlink(path) {
                if (path === locked) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
                await defaultOperations.unlink(path)
            },
            rmdir: (path) => defaultOperations.rmdir(path)
        }

        const result = await removeContentsCandidate(required(await detect()), callbacks, operations)

        expect(await readdir(root)).toEqual(['dir'])
        expect(await readdir(join(root, 'dir'))).toEqual(['locked.tmp'])
        // The locked file is reported once. Its directory is kept without a second report.
        expect(skipped.map((entry) => entry.path)).toEqual([locked])
        expect(skipped[0]?.reason).toContain('EBUSY')
        expect(removed.filter((entry) => entry.kind === 'file').map((entry) => entry.path.split(/[\\/]/).pop())).toEqual(expect.arrayContaining(['free.tmp', 'sibling.tmp']))
        expect(result.removedEntries).toBe(2)
    })

    test('refuses to remove when the directory changed after detection', async () => {
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'a.tmp'))
        const candidate = required(await detect())
        await rm(root, { recursive: true })
        await mkdir(root)
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'b.tmp'))
        const { removed, callbacks } = recorder()

        await expect(removeContentsCandidate(candidate, callbacks)).rejects.toThrow('changed after detection')
        expect(removed).toEqual([])
        expect(await readdir(root)).toEqual(['b.tmp'])
    })
})
