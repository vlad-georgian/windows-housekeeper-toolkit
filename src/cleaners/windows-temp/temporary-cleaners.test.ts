import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, parse } from 'node:path'

import { runUnattendedCleanup } from '../../cleanup/operations.ts'
import { newSummary } from '../../cleanup/summary.ts'
import { AuditLogger } from '../../core/audit-logger.ts'
import { pathExists } from '../../core/filesystem/index.ts'
import type { RemovedEntry, SkippedEntry } from '../../core/types.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { hasProcessGuard } from '../../windows/processes.ts'
import { InternetCacheCleaner } from './internet-cache-cleaner.ts'
import { UserTempCleaner } from './user-temp-cleaner.ts'

let sandbox: Sandbox
const local = join('Users', 'test', 'AppData', 'Local')

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

function callbacksFor(removed: RemovedEntry[], skipped: SkippedEntry[]): { onRemoved: (entry: RemovedEntry) => Promise<void>; onSkipped: (entry: SkippedEntry) => Promise<void> } {
    return {
        onRemoved: async (entry) => {
            removed.push(entry)
        },
        onSkipped: async (entry) => {
            skipped.push(entry)
        }
    }
}

describe('per-user Temp cleaner', () => {
    test('belongs to the Windows temporary directory cleanup category', () => {
        const cleaner = new UserTempCleaner(sandbox.paths)
        expect(cleaner.category).toBe('windows-temp')
        expect(cleaner.id).toBe('user-temp')
    })

    test('offers the contents of the per-user Temp directory', async () => {
        await sandbox.file(join(local, 'Temp', 'installer.tmp'), 'abc')
        await sandbox.file(join(local, 'Temp', 'session', 'log.txt'), 'de')
        const candidates = await new UserTempCleaner(sandbox.paths).detect()
        expect(candidates).toHaveLength(1)
        expect(candidates[0]?.sizeBytes).toBe(5)
        expect(candidates[0]?.fileCount).toBe(2)
    })

    test.each([
        ['Documents', join('Users', 'test', 'Documents')],
        ['a source folder', join('Users', 'test', 'source')],
        ['a folder directly in the profile', join('Users', 'test', 'tmp')],
        ['the profile root', join('Users', 'test')],
        ['AppData', join('Users', 'test', 'AppData', 'Roaming')],
        ['LocalAppData', join('Users', 'test', 'AppData', 'Local')]
    ])('does not offer a TEMP that points at %s', async (_name, relative) => {
        await sandbox.file(join(relative, 'precious.txt'))
        const cleaner = new UserTempCleaner({ ...sandbox.paths, temp: join(sandbox.root, relative) })
        expect(await cleaner.detect()).toEqual([])
    })

    test('does not offer a TEMP that points at a drive root', async () => {
        const cleaner = new UserTempCleaner({ ...sandbox.paths, temp: parse(sandbox.root).root })
        expect(await cleaner.detect()).toEqual([])
    })

    test('offers a per-session folder inside the Temp directory', async () => {
        await sandbox.file(join(local, 'Temp', '2', 'a.tmp'))
        const cleaner = new UserTempCleaner({ ...sandbox.paths, temp: join(sandbox.paths.temp, '2') })
        expect(await cleaner.detect()).toHaveLength(1)
    })

    test('does not offer machine-wide Windows temporary folders', async () => {
        await sandbox.file(join('Windows', 'Temp', 'machine.tmp'))
        const cleaner = new UserTempCleaner({ ...sandbox.paths, temp: join(sandbox.root, 'Windows', 'Temp') })
        expect(await cleaner.detect()).toEqual([])
    })

    test('removes the contents but keeps the Temp directory', async () => {
        await sandbox.file(join(local, 'Temp', 'a.tmp'))
        await sandbox.file(join(local, 'Temp', 'dir', 'b.tmp'))
        const cleaner = new UserTempCleaner(sandbox.paths)
        const removed: RemovedEntry[] = []
        for (const candidate of await cleaner.detect()) await cleaner.remove(candidate, callbacksFor(removed, []))
        expect(await readdir(sandbox.paths.temp)).toEqual([])
        expect(removed.length).toBeGreaterThan(0)
        expect(await pathExists(join(sandbox.root, local, 'Microsoft'))).toBe(false)
    })
})

describe('per-user Temporary Internet Files cleaner', () => {
    test('offers the contents of the INetCache directory', async () => {
        await sandbox.file(join(local, 'Microsoft', 'Windows', 'INetCache', 'IE', 'cached.htm'), '1234')
        await sandbox.file(join(local, 'Temp', 'other.tmp'))
        const candidates = await new InternetCacheCleaner(sandbox.paths).detect()
        expect(candidates).toHaveLength(1)
        expect(candidates[0]?.sizeBytes).toBe(4)
        expect(candidates[0]?.path).toBe(join(sandbox.root, local, 'Microsoft', 'Windows', 'INetCache'))
    })

    test('offers nothing when the cache is absent', async () => {
        expect(await new InternetCacheCleaner(sandbox.paths).detect()).toEqual([])
    })
})

// A real sharing violation, not a simulated one: PowerShell opens the file without sharing.
describe.skipIf(process.platform !== 'win32')('locked files on Windows', () => {
    test('keeps a locked file and removes its unlocked sibling', async () => {
        const locked = await sandbox.file(join(local, 'Temp', 'locked.tmp'), 'in use')
        const sibling = await sandbox.file(join(local, 'Temp', 'sibling.tmp'), 'free')
        const holder = Bun.spawn(
            [
                'powershell.exe',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$f = [System.IO.File]::Open($env:HOUSEKEEPER_LOCK, 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Close()`
            ],
            { env: { ...process.env, HOUSEKEEPER_LOCK: locked }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }
        )
        try {
            const reader = holder.stdout.getReader()
            const first = await reader.read()
            expect(new TextDecoder().decode(first.value)).toContain('locked')

            const cleaner = new UserTempCleaner(sandbox.paths)
            const removed: RemovedEntry[] = []
            const skipped: SkippedEntry[] = []
            for (const candidate of await cleaner.detect()) await cleaner.remove(candidate, callbacksFor(removed, skipped))

            expect(await pathExists(locked)).toBe(true)
            expect(await pathExists(sibling)).toBe(false)
            expect(skipped.map((entry) => entry.path)).toEqual([locked])
        } finally {
            await holder.stdin.write('\n')
            await holder.stdin.end()
            await holder.exited
        }
    }, 30_000)
})

describe('audit log inside the Temp directory', () => {
    test('keeps the active audit log, and its history, while emptying the rest', async () => {
        const logDirectory = join(sandbox.paths.temp, 'logs')
        const audit = await AuditLogger.create(logDirectory)
        await sandbox.file(join(local, 'Temp', 'a.tmp'))
        await sandbox.file(join(local, 'Temp', 'dir', 'b.tmp'))
        const session = { audit, summary: newSummary(), dryRun: false, selectedCleaners: new Set<string>() }

        await runUnattendedCleanup([new UserTempCleaner(sandbox.paths)], session)

        expect(await readdir(sandbox.paths.temp)).toEqual(['logs'])
        const log = await readFile(audit.path, 'utf8')
        expect(log).toContain('"session-start"')
        expect(log).toContain('"candidate-detected"')
        expect(log).toContain('"entry-removed"')
        expect(log).toContain('"entry-skipped"')
        expect(session.summary.skippedEntries).toBe(1)
        expect(session.summary.failures).toBe(0)
    })
})

describe('running-app check', () => {
    test('applies no process guard, because locked files are skipped instead', () => {
        for (const cleaner of [new UserTempCleaner(sandbox.paths), new InternetCacheCleaner(sandbox.paths)]) {
            expect(hasProcessGuard(cleaner.appId)).toBe(false)
        }
    })
})
