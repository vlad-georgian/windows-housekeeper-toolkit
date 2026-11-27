import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { newSummary } from '../cleanup/summary.ts'
import { AuditLogger } from '../core/audit-logger.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { createLaunchOperations } from './operations.ts'

let sandbox: Sandbox

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

describe('launch operations', () => {
    test('offers app startup management after the cleanup operations', async () => {
        const operations = createLaunchOperations({
            paths: sandbox.paths,
            cleaners: [],
            cleanup: { audit: await AuditLogger.create(sandbox.root), summary: newSummary(), dryRun: true, selectedCleaners: new Set() },
            startup: []
        })
        expect(operations.map((operation) => operation.id)).toEqual(['caches', 'old-installations', 'startup'])
        expect(operations.at(-1)?.label).toBe('Manage automatic startup')
    })
})
