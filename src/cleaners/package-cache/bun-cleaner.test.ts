import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link } from 'node:fs/promises'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { BunCacheCleaner } from './bun-cleaner.ts'

let sandbox: Sandbox
const cache = join('Users', 'test', '.bun', 'install', 'cache')

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

describe('Bun package cache', () => {
    test('offers downloaded package versions and preserves packages linked into projects', async () => {
        await sandbox.file(join(cache, 'left-pad@1.3.0@@@1', 'package.json'))
        await sandbox.file(join(cache, '@scope', 'tool@2.0.0@@@1', 'index.js'))
        const shared = await sandbox.file(join(cache, 'linked@1.0.0@@@1', 'package.json'))
        await sandbox.directory(join('project', 'node_modules', 'linked'))
        await link(shared, join(sandbox.root, 'project', 'node_modules', 'linked', 'package.json'))
        await sandbox.directory(join(cache, 'left-pad'))

        const cleaner = new BunCacheCleaner(sandbox.paths, {})
        const candidates = await cleaner.detect()
        expect(candidates.map((candidate) => candidate.displayName).toSorted()).toEqual(['Bun cached @scope/tool@2.0.0', 'Bun cached left-pad@1.3.0'])
        expect(cleaner.implications).toContain('offline')
    })

    test('ignores a cache directory outside the user profile', async () => {
        await sandbox.file(join('elsewhere', 'cache', 'left-pad@1.3.0@@@1', 'package.json'))
        const cleaner = new BunCacheCleaner(sandbox.paths, {
            BUN_INSTALL_CACHE_DIR: join(sandbox.root, 'elsewhere', 'cache')
        })
        expect(await cleaner.detect()).toEqual([])
    })
})
