import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { ScoopCacheCleaner } from './scoop-cleaner.ts'

let sandbox: Sandbox
const scoop = join('Users', 'test', 'scoop')

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

describe('Scoop download cache', () => {
    test('offers downloaded archives and preserves installs and in-progress downloads', async () => {
        await sandbox.file(join(scoop, 'apps', 'scoop', 'current', 'bin', 'scoop.ps1'))
        await sandbox.file(join(scoop, 'apps', 'nodejs', '26.11.1', 'node.exe'))
        await sandbox.file(join(scoop, 'cache', 'nodejs#26.11.1#bbcff94.7z'))
        await sandbox.file(join(scoop, 'cache', 'lazygit#0.66.1#63fdc7a.zip'))
        await sandbox.file(join(scoop, 'cache', 'git#2.50.0#abc1234.7z.download'))
        await sandbox.file(join(scoop, 'cache', 'notes.txt'))

        const candidates = await new ScoopCacheCleaner(sandbox.paths, {}).detect()
        expect(candidates.map((candidate) => candidate.displayName).toSorted()).toEqual(['Scoop cached lazygit 0.66.1', 'Scoop cached nodejs 26.11.1'])
    })

    test('offers nothing unless a per-user Scoop installation is verified', async () => {
        await sandbox.file(join(scoop, 'cache', 'nodejs#26.11.1#bbcff94.7z'))
        expect(await new ScoopCacheCleaner(sandbox.paths, {}).detect()).toEqual([])
    })
})
