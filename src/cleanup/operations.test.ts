import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AuditLogger } from '../core/audit-logger.ts'
import type { AppCleaner, CleanupCandidate, CleanupCategoryId } from '../core/types.ts'
import { cancelled, type LaunchOperation, type PlanSection } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { type CleanupSession, createCleanupOperations, runUnattendedCleanup } from './operations.ts'
import { describeSummary, newSummary } from './summary.ts'

const removed: string[] = []

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Missing operation.')
    return value
}

function planned(result: PlanSection | null | typeof cancelled): PlanSection {
    if (result === null || result === cancelled) throw new Error('Expected a plan section.')
    return result
}

function fakeCleaner(id: string, category: CleanupCategoryId, sizes: readonly number[], implications?: string): AppCleaner {
    return {
        id,
        appId: `test-${id}`,
        category,
        label: `App ${id}`,
        description: `${id} data`,
        ...(implications === undefined ? {} : { implications }),
        detect: async (): Promise<CleanupCandidate[]> =>
            sizes.map((sizeBytes, index) => ({
                id: `${id}:${index}`,
                kind: 'filesystem',
                displayName: `${id} target ${index}`,
                reason: 'test',
                sizeBytes,
                fileCount: 1,
                modifiedAt: null
            })),
        remove: async (candidate, callbacks) => {
            removed.push(candidate.id)
            await callbacks.onRemoved({
                kind: 'file',
                path: candidate.displayName,
                sizeBytes: candidate.sizeBytes,
                modifiedAt: null
            })
            return { removedEntries: 1, reclaimedBytes: candidate.sizeBytes ?? 0 }
        }
    }
}

const catalog = [
    fakeCleaner('codex', 'general-cache', [1024]),
    fakeCleaner('empty', 'general-cache', []),
    fakeCleaner('npm', 'destructive-cache', [2048], 'Packages download again.'),
    fakeCleaner('discord-versions', 'old-installations', [4096])
]

let sandbox: Sandbox
let session: CleanupSession
let caches: LaunchOperation
let installations: LaunchOperation

async function startSession(dryRun: boolean): Promise<void> {
    session = {
        audit: await AuditLogger.create(sandbox.root),
        summary: newSummary(),
        dryRun,
        selectedCleaners: new Set()
    }
    const operations = createCleanupOperations(catalog, session)
    const byId = new Map(operations.map((operation) => [operation.id, operation]))
    caches = required(byId.get('caches'))
    installations = required(byId.get('old-installations'))
}

beforeEach(async () => {
    removed.length = 0
    sandbox = await createSandbox()
    await startSession(true)
})
afterEach(() => sandbox.dispose())

describe('cache cleanup operation', () => {
    test('presents general caches, then a separate package-cache checklist, all unchecked', async () => {
        const prompts = new FakePrompts([[], []])
        expect(await caches.gather(prompts)).toBeNull()
        expect(prompts.checklists.map((request) => request.options.map((o) => o.value))).toEqual([['codex'], ['npm']])
        for (const request of prompts.checklists) expect(request.initialValues).toEqual([])
        expect(prompts.checklists[1]?.options[0]?.hint).toContain('Packages download again.')
    })

    test('cancelling the package-cache checklist cancels the operation', async () => {
        const prompts = new FakePrompts([['codex'], null])
        expect(await caches.gather(prompts)).toBe(cancelled)
    })

    test('plans the selected caches with their implications and previews them in a dry run', async () => {
        const prompts = new FakePrompts([['codex'], ['npm']])
        const section = planned(await caches.gather(prompts))
        expect(section.title).toBe('Remove caches')
        expect(section.lines).toEqual([
            'General cache cleanup',
            '  App codex: 1 target(s), 1.0 KiB',
            'Destructive cache cleanup',
            '  App npm: 1 target(s), 2.0 KiB. Packages download again.'
        ])
        await section.apply()
        expect(removed).toEqual([])
        expect(session.summary.detectedBytes).toBe(3072)
        expect([...session.selectedCleaners]).toEqual(['codex', 'npm'])
    })

    test('applies only the selected cleaners outside a dry run', async () => {
        await startSession(false)
        const prompts = new FakePrompts([['codex'], []])
        const section = planned(await caches.gather(prompts))
        await section.apply()
        expect(removed).toEqual(['codex:0'])
        expect(session.summary.reclaimedBytes).toBe(1024)
    })
})

describe('old-installation cleanup operation', () => {
    test('offers only old installations, unchecked', async () => {
        const prompts = new FakePrompts([['discord-versions']])
        const section = planned(await installations.gather(prompts))
        expect(prompts.checklists).toHaveLength(1)
        expect(prompts.checklists[0]?.initialValues).toEqual([])
        expect(section.lines).toEqual(['Old data and installations', '  App discord-versions: 1 target(s), 4.0 KiB'])
    })
})

describe('cache cleanup operation with Windows temporary directory cleanup', () => {
    const withTemp = [...catalog, fakeCleaner('user-temp', 'windows-temp', [8192], 'Files in use are skipped.')]

    test('presents Windows temporary directory cleanup as the third checklist, unchecked', async () => {
        const operations = createCleanupOperations(withTemp, session)
        const operation = required(operations.find((entry) => entry.id === 'caches'))
        const prompts = new FakePrompts([[], [], ['user-temp']])

        const section = planned(await operation.gather(prompts))

        expect(prompts.checklists.map((request) => request.options.map((o) => o.value))).toEqual([['codex'], ['npm'], ['user-temp']])
        for (const request of prompts.checklists) expect(request.initialValues).toEqual([])
        expect(section.lines).toEqual(['Windows temporary directory cleanup', '  App user-temp: 1 target(s), 8.0 KiB. Files in use are skipped.'])
    })

    test('cancelling the Windows temporary directory cleanup checklist cancels the operation', async () => {
        const operations = createCleanupOperations(withTemp, session)
        const operation = required(operations.find((entry) => entry.id === 'caches'))
        expect(await operation.gather(new FakePrompts([['codex'], ['npm'], null]))).toBe(cancelled)
    })
})

describe('skipped entries', () => {
    test('counts entries a cleaner leaves in place and records each in the audit log', async () => {
        await startSession(false)
        const cleaner: AppCleaner = {
            ...fakeCleaner('user-temp', 'windows-temp', [10]),
            remove: async (_candidate, callbacks) => {
                await callbacks.onSkipped?.({ path: join(sandbox.root, 'locked.tmp'), reason: 'EBUSY: resource busy or locked' })
                return { removedEntries: 0, reclaimedBytes: 0 }
            }
        }

        await runUnattendedCleanup([cleaner], session)

        expect(session.summary.skippedEntries).toBe(1)
        expect(session.summary.failures).toBe(0)
        const log = await readFile(session.audit.path, 'utf8')
        expect(log).toContain('"entry-skipped"')
        expect(log).toContain('locked.tmp')
        expect(describeSummary(session.summary, false, session.audit.path)).toContain('Locked or inaccessible entries skipped: 1.')
    })
})
