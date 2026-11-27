import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { newSummary } from '../cleanup/summary.ts'
import { AuditLogger } from '../core/audit-logger.ts'
import { writeState } from '../core/state.ts'
import { runLaunchMenu } from '../launch/menu.ts'
import { cancelled, type LaunchOperation, type PlanSection } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { FakeStartupBackend, otherEntry, runEntry } from '../test-support/fake-startup-backend.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { readPreferences, savePreferences } from '../windows/app-startup/preferences.ts'
import { readSignInSettings } from '../windows/signin.ts'
import { createStartupOperation, type StartupSession } from './operation.ts'
import { createSignInStartupProvider } from './signin-provider.ts'
import type { StartupChoice, StartupProvider } from './types.ts'

const t3 = String.raw`C:\Users\test\AppData\Local\Programs\t3code\T3 Code.exe`
const opencode = String.raw`C:\Users\test\AppData\Local\Programs\ai.opencode.desktop\OpenCode.exe`
const claudeMachine = String.raw`C:\Program Files\Claude\Claude.exe`

let sandbox: Sandbox
let session: StartupSession

async function startSession(dryRun: boolean): Promise<void> {
    session = { audit: await AuditLogger.create(sandbox.root), summary: newSummary(), dryRun }
}

beforeEach(async () => {
    sandbox = await createSandbox()
    await startSession(false)
})
afterEach(() => sandbox.dispose())

function planned(result: PlanSection | null | typeof cancelled): PlanSection {
    if (result === null || result === cancelled) throw new Error('Expected a plan section.')
    return result
}

function signInOperation(backend: FakeStartupBackend): LaunchOperation {
    return createStartupOperation([createSignInStartupProvider(sandbox.paths, backend)], session)
}

function stubProvider(applied: string[], failing: readonly string[] = []): StartupProvider {
    const choice = (id: string): StartupChoice => ({
        id,
        label: `Item ${id}`,
        planLines: [`change ${id}`],
        apply: () => {
            if (failing.includes(id)) return Promise.reject(new Error(`${id} refused`))
            applied.push(id)
            return Promise.resolve(`changed ${id}`)
        }
    })
    return {
        id: 'stub',
        inspect: () =>
            Promise.resolve({
                notes: [{ title: 'Informational', lines: ['reported only'] }],
                groups: [
                    { id: 'first', title: 'First group', message: 'Pick from the first group.', choices: [choice('a'), choice('b')] },
                    { id: 'empty', title: 'Empty group', message: 'Never shown.', choices: [] },
                    { id: 'second', title: 'Second group', message: 'Pick from the second group.', choices: [choice('c')] }
                ]
            })
    }
}

describe('startup operation', () => {
    test('is a launch menu choice for automatic startup', () => {
        const operation = createStartupOperation([], session)
        expect(operation.id).toBe('startup')
        expect(operation.label).toBe('Manage automatic startup')
    })

    test('asks one unchecked checklist per non-empty group, reports notes, and plans only the selection', async () => {
        const applied: string[] = []
        const prompts = new FakePrompts([['b'], ['c']])
        const section = planned(await createStartupOperation([stubProvider(applied)], session).gather(prompts))

        expect(prompts.notes).toEqual([{ title: 'Informational', lines: ['reported only'] }])
        expect(prompts.checklists.map((request) => request.message)).toEqual([expect.stringContaining('first group'), expect.stringContaining('second group')])
        expect(prompts.checklists.map((request) => request.options.map((option) => option.value))).toEqual([['a', 'b'], ['c']])
        for (const request of prompts.checklists) expect(request.initialValues).toEqual([])
        expect(section.lines).toEqual(['First group', '  change b', 'Second group', '  change c'])

        await section.apply()
        expect(applied).toEqual(['b', 'c'])
    })

    test('plans nothing when every checklist is empty', async () => {
        const prompts = new FakePrompts([[], []])
        expect(await createStartupOperation([stubProvider([])], session).gather(prompts)).toBeNull()
    })

    test('cancelling any checklist cancels the operation without applying anything', async () => {
        const applied: string[] = []
        const prompts = new FakePrompts([['a'], null])
        expect(await createStartupOperation([stubProvider(applied)], session).gather(prompts)).toBe(cancelled)
        expect(applied).toEqual([])
    })

    test('a dry run applies nothing', async () => {
        await startSession(true)
        const applied: string[] = []
        const section = planned(await createStartupOperation([stubProvider(applied)], session).gather(new FakePrompts([['a'], ['c']])))
        await section.apply()
        expect(applied).toEqual([])
        expect(session.summary.failures).toBe(0)
    })

    test('keeps applying after a failure and records it in the summary', async () => {
        const applied: string[] = []
        const section = planned(await createStartupOperation([stubProvider(applied, ['a'])], session).gather(new FakePrompts([['a', 'b'], ['c']])))
        await section.apply()
        expect(applied).toEqual(['b', 'c'])
        expect(session.summary.failures).toBe(1)
        expect([...session.summary.failedApps]).toEqual(['startup'])
    })

    test('a provider that cannot inspect is reported while the other providers still offer their choices', async () => {
        const applied: string[] = []
        const broken: StartupProvider = { id: 'broken', inspect: () => Promise.reject(new Error('PowerShell timed out')) }
        const prompts = new FakePrompts([['a'], []])
        const section = planned(await createStartupOperation([broken, stubProvider(applied)], session).gather(prompts))
        expect(prompts.notes[0]).toEqual({ title: 'Could not inspect startup source "broken"', lines: ['PowerShell timed out'] })
        expect(section.lines).toEqual(['First group', '  change a'])
        expect(session.summary.failures).toBe(1)
        expect([...session.summary.failedApps]).toEqual(['startup'])
    })

    test('records successful changes and failures in the audit log', async () => {
        const applied: string[] = []
        const section = planned(await createStartupOperation([stubProvider(applied, ['a'])], session).gather(new FakePrompts([['a', 'b'], []])))
        await section.apply()
        const records = (await Bun.file(session.audit.path).text())
            .trim()
            .split('\n')
            .map((line): unknown => JSON.parse(line))
        expect(records).toContainEqual(expect.objectContaining({ event: 'startup-changes', dryRun: false, messages: ['changed b'], failures: 1 }))
    })

    test('records a dry run in the audit log without applying', async () => {
        await startSession(true)
        const section = planned(await createStartupOperation([stubProvider([])], session).gather(new FakePrompts([['a'], []])))
        await section.apply()
        const records = (await Bun.file(session.audit.path).text())
            .trim()
            .split('\n')
            .map((line): unknown => JSON.parse(line))
        expect(records).toContainEqual(expect.objectContaining({ event: 'startup-changes', dryRun: true, messages: ['Item a was not changed (dry run)'], failures: 0 }))
    })

    test('reports nothing to manage when no provider offers a choice', async () => {
        const prompts = new FakePrompts([])
        expect(await createStartupOperation([{ id: 'none', inspect: () => Promise.resolve({ notes: [], groups: [] }) }], session).gather(prompts)).toBeNull()
    })
})

function machine(): FakeStartupBackend {
    return new FakeStartupBackend(
        [runEntry('t3-code', 'T3 Code', t3), runEntry('opencode', 'OpenCode', opencode)],
        [otherEntry('claude', 'Claude', 'HKLM (Registry64) Run', claudeMachine), otherEntry('codex', String.raw`\OpenAI\Codex`, 'Scheduled task', 'codex.exe')],
        ['claude'],
        ['Could not inspect HKLM (Registry32) Run: denied']
    )
}

describe('sign-in app startup', () => {
    test('offers verified current-user entries and reports other startup mechanisms separately', async () => {
        const prompts = new FakePrompts([[]])
        expect(await signInOperation(machine()).gather(prompts)).toBeNull()

        const [request] = prompts.checklists
        expect(prompts.checklists).toHaveLength(1)
        expect(request?.options.map((option) => option.label)).toEqual(['T3 Code · T3 Code', 'OpenCode · OpenCode'])
        expect(request?.options.every((option) => option.hint?.includes('Current user sign-in (HKCU Run)'))).toBe(true)
        expect(request?.initialValues).toEqual([])

        const lines = prompts.notes.flatMap((note) => note.lines).join('\n')
        expect(prompts.notes[0]?.title).toContain('not changed')
        expect(lines).toContain(`Claude · Claude · HKLM (Registry64) Run`)
        expect(lines).toContain('Codex')
        expect(lines).toContain('Scheduled task')
        expect(lines).toContain('Windows Settings')
        expect(lines).toContain('Could not inspect HKLM (Registry32) Run: denied')
        expect(lines).not.toContain('T3 Code · T3 Code')
    })

    test('previews the exact entries to disable and applies only those selected', async () => {
        const fake = machine()
        const prompts = new FakePrompts([[`disable:t3-code:t3 code`]])
        const section = planned(await signInOperation(fake).gather(prompts))
        expect(section.title).toBe('Manage automatic startup')
        expect(section.lines.join('\n')).toContain('T3 Code · T3 Code')
        expect(section.lines.join('\n')).toContain(runEntry('t3-code', 'T3 Code', t3).command)
        expect(section.lines.join('\n')).not.toContain('OpenCode')
        expect(fake.changes).toEqual([])

        await section.apply()
        expect(fake.changes).toEqual(['disable T3 Code'])
        expect(fake.runValue('OpenCode')).toBeDefined()
        expect((await readPreferences(sandbox.paths)).map((preference) => preference.name)).toEqual(['T3 Code'])
    })

    test('restores saved entries from the same workflow, then offers nothing more to restore', async () => {
        const fake = machine()
        const disable = planned(await signInOperation(fake).gather(new FakePrompts([['disable:t3-code:t3 code', 'disable:opencode:opencode']])))
        await disable.apply()
        expect(fake.runValue('T3 Code')).toBeUndefined()

        const prompts = new FakePrompts([['restore:t3-code:t3 code']])
        const restore = planned(await signInOperation(fake).gather(prompts))
        expect(prompts.checklists).toHaveLength(1)
        expect(prompts.checklists[0]?.options.map((option) => option.label)).toEqual(['T3 Code · T3 Code', 'OpenCode · OpenCode'])
        expect(prompts.checklists[0]?.initialValues).toEqual([])
        expect(restore.lines.join('\n')).toContain('T3 Code · T3 Code')
        expect(restore.lines.join('\n')).not.toContain('OpenCode')

        await restore.apply()
        expect(fake.runValue('T3 Code')).toBe(runEntry('t3-code', 'T3 Code', t3).command)
        expect(fake.runValue('OpenCode')).toBeUndefined()
        expect((await readPreferences(sandbox.paths)).map((preference) => preference.name)).toEqual(['OpenCode'])
    })

    test('lists disable and restore choices in separate checklists', async () => {
        const fake = machine()
        await planned(await signInOperation(fake).gather(new FakePrompts([['disable:opencode:opencode']]))).apply()
        const prompts = new FakePrompts([[], []])
        expect(await signInOperation(fake).gather(prompts)).toBeNull()
        expect(prompts.checklists.map((request) => request.options.map((option) => option.label))).toEqual([['T3 Code · T3 Code'], ['OpenCode · OpenCode']])
    })

    test('finishes a restore that was interrupted after the value was written', async () => {
        const fake = new FakeStartupBackend()
        const entry = runEntry('opencode', 'OpenCode', opencode)
        await savePreferences(sandbox.paths, [{ app: 'opencode', name: 'OpenCode', command: entry.command, valueKind: 'String', target: opencode, restorePending: true }])
        const prompts = new FakePrompts([['restore:opencode:opencode']])
        await planned(await signInOperation(fake).gather(prompts)).apply()
        expect(fake.runValue('OpenCode')).toBe(entry.command)
        expect(prompts.checklists[0]?.options[0]?.hint).toContain('Restore was interrupted')
        expect(session.summary.failures).toBe(0)
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('a failed restore can be retried', async () => {
        const fake = machine()
        await planned(await signInOperation(fake).gather(new FakePrompts([['disable:opencode:opencode']]))).apply()
        fake.failing.add('opencode')
        await planned(await signInOperation(fake).gather(new FakePrompts([[], ['restore:opencode:opencode']]))).apply()
        expect(session.summary.failures).toBe(1)

        fake.failing.clear()
        const prompts = new FakePrompts([[], ['restore:opencode:opencode']])
        await planned(await signInOperation(fake).gather(prompts)).apply()
        expect(prompts.checklists.map((request) => request.options.map((option) => option.label))).toEqual([['T3 Code · T3 Code'], ['OpenCode · OpenCode']])
        expect(fake.runValue('OpenCode')).toBeDefined()
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('an entry with a saved preference is offered only for restore, even when the app registered it again', async () => {
        const fake = machine()
        await planned(await signInOperation(fake).gather(new FakePrompts([['disable:t3-code:t3 code']]))).apply()
        fake.register(runEntry('t3-code', 'T3 Code', t3))

        const prompts = new FakePrompts([[], []])
        expect(await signInOperation(fake).gather(prompts)).toBeNull()
        expect(prompts.checklists.map((request) => request.options.map((option) => option.label))).toEqual([['OpenCode · OpenCode'], ['T3 Code · T3 Code']])
        expect(prompts.checklists[1]?.options[0]?.hint).toContain('registered it again')
    })

    test('restoring an entry the app registered again with a different command forgets the preference without failing', async () => {
        const fake = machine()
        await planned(await signInOperation(fake).gather(new FakePrompts([['disable:t3-code:t3 code']]))).apply()
        const reregistered = { ...runEntry('t3-code', 'T3 Code', t3), command: `"${t3}" --minimized` }
        fake.register(reregistered)

        const section = planned(await signInOperation(fake).gather(new FakePrompts([[], ['restore:t3-code:t3 code']])))
        expect(section.lines.join('\n')).toContain('forgets the saved preference')
        await section.apply()
        expect(session.summary.failures).toBe(0)
        expect(fake.runValue('T3 Code')).toBe(reregistered.command)
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('turning off refuses an entry that changed after the plan was shown', async () => {
        const fake = machine()
        const section = planned(await signInOperation(fake).gather(new FakePrompts([['disable:t3-code:t3 code']])))
        fake.register({ ...runEntry('t3-code', 'T3 Code', t3), command: `"${t3}" --minimized` })
        await section.apply()
        expect(session.summary.failures).toBe(1)
        expect(fake.changes).toEqual([])
        expect(fake.runValue('T3 Code')).toContain('--minimized')
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('an invalid saved-preferences file does not stop the launch menu', async () => {
        await writeState(sandbox.paths, 'app-startup.json', { not: 'a list' })
        const other: LaunchOperation = {
            id: 'other',
            label: 'Other',
            gather: () => Promise.resolve({ title: 'Other plan', lines: ['other line'], apply: () => Promise.resolve() })
        }
        const prompts = new FakePrompts([['other', 'startup'], true])
        const outcome = await runLaunchMenu([other, signInOperation(machine())], prompts, { dryRun: false })
        expect(outcome).toBe('applied')
        expect(prompts.notes.map((note) => note.title)).toContain('Could not inspect startup source "signin"')
        expect(session.summary.failures).toBe(1)
    })

    test('cancelling a checklist leaves every entry and preference unchanged', async () => {
        const fake = machine()
        await planned(await signInOperation(fake).gather(new FakePrompts([['disable:opencode:opencode']]))).apply()
        const prompts = new FakePrompts([['disable:t3-code:t3 code'], null])
        expect(await signInOperation(fake).gather(prompts)).toBe(cancelled)
        expect(fake.changes).toEqual(['disable OpenCode'])
        expect(fake.runValue('T3 Code')).toBeDefined()
        expect((await readPreferences(sandbox.paths)).map((preference) => preference.name)).toEqual(['OpenCode'])
    })

    test('a dry run previews without changing entries or saving preferences', async () => {
        await startSession(true)
        const fake = machine()
        const section = planned(await signInOperation(fake).gather(new FakePrompts([['disable:t3-code:t3 code']])))
        await section.apply()
        expect(fake.changes).toEqual([])
        expect(fake.runValue('T3 Code')).toBeDefined()
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('through the launch menu, declining the combined plan changes nothing', async () => {
        const fake = machine()
        const prompts = new FakePrompts([['startup'], ['disable:t3-code:t3 code'], false])
        const outcome = await runLaunchMenu([signInOperation(fake)], prompts, { dryRun: false })
        expect(outcome).toBe('declined')
        expect(prompts.notes.at(-1)?.title).toBe('Plan')
        expect(fake.changes).toEqual([])
        expect(await readPreferences(sandbox.paths)).toEqual([])
    })

    test('through the launch menu, confirming applies the plan', async () => {
        const fake = machine()
        const outcome = await runLaunchMenu([signInOperation(fake)], new FakePrompts([['startup'], ['disable:t3-code:t3 code'], true]), { dryRun: false })
        expect(outcome).toBe('applied')
        expect(fake.changes).toEqual(['disable T3 Code'])
    })

    test('leaves startup preference enforcement as the user configured it', async () => {
        await writeState(sandbox.paths, 'signin.json', { cleanupEnabled: false, cleanupApps: [], enforcementEnabled: true })
        const fake = machine()
        await planned(await signInOperation(fake).gather(new FakePrompts([['disable:t3-code:t3 code']]))).apply()
        await planned(await signInOperation(fake).gather(new FakePrompts([[], ['restore:t3-code:t3 code']]))).apply()
        expect((await readSignInSettings(sandbox.paths)).enforcementEnabled).toBe(true)
    })

    test('reports nothing to manage when no sign-in entries or saved preferences exist', async () => {
        const prompts = new FakePrompts([])
        expect(await signInOperation(new FakeStartupBackend()).gather(prompts)).toBeNull()
        expect(prompts.checklists).toEqual([])
    })
})
