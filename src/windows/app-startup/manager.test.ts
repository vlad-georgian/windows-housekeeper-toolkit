import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { FakeStartupBackend, otherEntry, runEntry } from '../../test-support/fake-startup-backend.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { disableSignInEntry, reapplyStartupPreferences, restoreSignInEntry } from './manager.ts'
import { readPreferences } from './preferences.ts'

const t3 = String.raw`C:\Users\test\AppData\Local\Programs\t3code\T3 Code.exe`

/** The message of the error a promise rejects with. */
async function failure(promise: Promise<unknown>): Promise<string> {
    try {
        await promise
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
    throw new Error('Expected the promise to reject.')
}
let sandbox: Sandbox

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

describe('sign-in entry management', () => {
    test('disabling saves the previous value, and restoring writes it back and forgets the preference', async () => {
        const entry = runEntry('t3-code', 'T3 Code', t3)
        const backend = new FakeStartupBackend([entry])

        await disableSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        expect(backend.runValue('T3 Code')).toBeUndefined()
        expect(await readPreferences(sandbox.paths)).toEqual([{ app: 't3-code', name: 'T3 Code', command: entry.command, valueKind: 'String', target: t3, restorePending: false }])

        await restoreSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        expect(backend.runValue('T3 Code')).toBe(entry.command)
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('refuses entries that are not supported HKCU Run values', async () => {
        const backend = new FakeStartupBackend([], [otherEntry('t3-code', 'T3 Code', 'HKLM (Registry64) Run', t3)], ['t3-code'])
        expect(await failure(disableSignInEntry(sandbox.paths, backend, 't3-code'))).toContain('No matching manageable startup entry found for T3 Code. Open Windows Settings')
        expect(backend.changes).toEqual([])
    })

    test('requires a name when an app has several entries', async () => {
        const backend = new FakeStartupBackend([runEntry('t3-code', 'One', t3), runEntry('t3-code', 'Two', t3)])
        expect(await failure(disableSignInEntry(sandbox.paths, backend, 't3-code'))).toContain('Choose one startup entry by name: One, Two.')
    })

    test('restore finishes an interrupted restore instead of disabling again', async () => {
        const entry = runEntry('t3-code', 'T3 Code', t3)
        const backend = new FakeStartupBackend([entry])
        await disableSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        backend.failing.add('t3 code')
        expect(await failure(restoreSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code'))).toContain('Simulated failure')
        expect((await readPreferences(sandbox.paths))[0]?.restorePending).toBe(true)
        expect(await failure(disableSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code'))).toContain('Finish restoring T3 Code')

        backend.failing.clear()
        await restoreSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        expect(backend.runValue('T3 Code')).toBe(entry.command)
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })
})

describe('startup preference enforcement', () => {
    test('disables entries that reappeared, and skips a restore in progress', async () => {
        const entry = runEntry('t3-code', 'T3 Code', t3)
        const backend = new FakeStartupBackend([entry])
        await disableSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        await backend.changeRunValue((await readPreferences(sandbox.paths))[0]!, true)
        expect(backend.runValue('T3 Code')).toBe(entry.command)

        const result = await reapplyStartupPreferences(sandbox.paths, backend)
        expect(result).toEqual({ messages: ['T3 Code startup · T3 Code · disabled'], failures: 0 })
        expect(backend.runValue('T3 Code')).toBeUndefined()
    })

    test('does nothing after the preference was restored through the same workflow', async () => {
        const backend = new FakeStartupBackend([runEntry('t3-code', 'T3 Code', t3)])
        await disableSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        await restoreSignInEntry(sandbox.paths, backend, 't3-code', 'T3 Code')
        expect(await reapplyStartupPreferences(sandbox.paths, backend)).toEqual({ messages: [], failures: 0 })
        expect(backend.runValue('T3 Code')).toBeDefined()
    })
})
