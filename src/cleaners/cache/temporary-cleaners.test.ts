import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import type { RemovedEntry, SkippedEntry } from '../../core/types.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
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
    test('belongs to the Windows temporary directories category', () => {
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
