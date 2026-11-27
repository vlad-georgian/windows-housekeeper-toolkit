import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import type { CleanupCandidate, RemovedEntry, SkippedEntry } from '../types.ts'
import { pathExists } from './paths.ts'
import { createContentsCandidate, defaultContentsOperations as defaultOperations, removeContentsCandidate, type ContentsOperations } from './temporary-contents.ts'

let sandbox: Sandbox
let root: string

// Creating file symlinks needs Developer Mode or elevation on Windows.
const canLinkFiles = await probeFileLinks()

async function probeFileLinks(): Promise<boolean> {
    const directory = await mkdtemp(join(tmpdir(), 'housekeeper-probe-'))
    try {
        await writeFile(join(directory, 'target'), 'x')
        await symlink(join(directory, 'target'), join(directory, 'link'), 'file')
        return true
    } catch {
        return false
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

beforeEach(async () => {
    sandbox = await createSandbox()
    root = sandbox.paths.temp
})
afterEach(() => sandbox.dispose())

async function detect(path = root): Promise<CleanupCandidate | null> {
    return createContentsCandidate({
        id: 'test:contents',
        root: path,
        allowed: [root],
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

    test.each([
        ['Documents', join('Users', 'test', 'Documents')],
        ['a source folder', join('Users', 'test', 'source')],
        ['a folder directly in the profile', join('Users', 'test', 'tmp')],
        ['machine-wide Windows Temp', join('Windows', 'Temp')]
    ])('offers nothing for %s', async (_name, relative) => {
        await sandbox.file(join(relative, 'a.tmp'))
        expect(await detect(join(sandbox.root, relative))).toBeNull()
    })

    test('offers nothing for the profile, AppData, or a drive root', async () => {
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'a.tmp'))
        for (const path of [sandbox.paths.home, sandbox.paths.localAppData, sandbox.paths.roamingAppData, parse(sandbox.root).root]) {
            expect(await detect(path)).toBeNull()
        }
    })

    test('offers a folder inside the allowed directory', async () => {
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', '2', 'a.tmp'))
        expect(await detect(join(root, '2'))).not.toBeNull()
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
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'plain.tmp'))
        const { removed, skipped, callbacks } = recorder()

        await removeContentsCandidate(required(await detect()), callbacks)

        expect(await readdir(root)).toEqual([])
        expect(skipped).toEqual([])
        expect(await Bun.file(outside).text()).toBe('precious')
        expect(removed.some((entry) => entry.kind === 'link' && entry.path.endsWith('junction'))).toBe(true)
    })

    test.skipIf(!canLinkFiles)('removes file symbolic links without touching their target', async () => {
        const outside = await sandbox.file(join('Users', 'test', 'Documents', 'keep.txt'), 'precious')
        await symlink(outside, join(root, 'file-link'), 'file')
        const { removed, callbacks } = recorder()

        await removeContentsCandidate(required(await detect()), callbacks)

        expect(await readdir(root)).toEqual([])
        expect(await Bun.file(outside).text()).toBe('precious')
        expect(removed.map((entry) => entry.kind)).toEqual(['link'])
    })

    test('keeps protected files, and reports them, while removing everything else', async () => {
        const log = await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'logs', 'run.log'), 'record')
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'logs', 'other.tmp'))
        await sandbox.file(join('Users', 'test', 'AppData', 'Local', 'Temp', 'sibling.tmp'))
        const { skipped, callbacks } = recorder()

        await removeContentsCandidate(required(await detect()), { ...callbacks, protectedPaths: [log] })

        expect(await readdir(root)).toEqual(['logs'])
        expect(await readdir(join(root, 'logs'))).toEqual(['run.log'])
        expect(await readFile(log, 'utf8')).toBe('record')
        // The log is reported once; its directory is kept without a second report.
        expect(skipped.map((entry) => entry.path)).toEqual([log])
        expect(skipped[0]?.reason).toContain('audit log')
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

        const failure = await removeContentsCandidate(candidate, callbacks).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(String(failure)).toContain('changed after detection')
        expect(removed).toEqual([])
        expect(await readdir(root)).toEqual(['b.tmp'])
    })
})
