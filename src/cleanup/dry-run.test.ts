import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCleaners } from '../cleaners/index.ts'
import { CodexInstallationCleaner } from '../cleaners/installations/codex-cleaner.ts'
import { AuditLogger } from '../core/audit-logger.ts'
import { pathExists } from '../core/filesystem/index.ts'
import type { CleanupCategoryId } from '../core/types.ts'
import { addCodexRelease, codexStorePath, selectCodexRelease } from '../test-support/codex-fixtures.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import type { WindowsProcess } from '../windows/processes.ts'
import { cleanersForCategories } from './categories.ts'
import { type CleanupSession, runUnattendedCleanup } from './operations.ts'
import { newSummary } from './summary.ts'

// Overrides that would point cleaners at real locations instead of the sandbox.
const overrides = ['CODEX_HOME', 'SCOOP', 'SCOOP_CACHE', 'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR', 'ChocolateyInstall']
const saved = new Map(overrides.map((name) => [name, process.env[name]]))
beforeAll(() => {
    for (const name of overrides) delete process.env[name]
})
afterAll(() => {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value
})

// The NVIDIA cleaner queries the live Windows Driver Store; its selection rules have their own
// parser. The Codex release cleaner gets a scripted process list instead of the live one.
const liveSystemCleaners = new Set(['nvidia-drivers'])
let runningProcesses: WindowsProcess[] = []

let sandbox: Sandbox
const home = join('Users', 'test')
const local = join(home, 'AppData', 'Local')

beforeEach(async () => {
    sandbox = await createSandbox()
    runningProcesses = [{ id: 1, name: 'explorer.exe', path: 'C:\\Windows\\explorer.exe' }]
})
afterEach(() => sandbox.dispose())

async function dryRun(category: CleanupCategoryId): Promise<{
    session: CleanupSession
    removedTargets: string[]
    log: string
}> {
    const cleaners = cleanersForCategories(createCleaners(sandbox.paths), [category])
        .filter((cleaner) => !liveSystemCleaners.has(cleaner.id))
        .map((cleaner) => (cleaner.id === 'codex-releases' ? new CodexInstallationCleaner(sandbox.paths, async () => runningProcesses) : cleaner))
    const session: CleanupSession = {
        audit: await AuditLogger.create(join(sandbox.root, 'logs')),
        summary: newSummary(),
        dryRun: true,
        selectedCleaners: new Set()
    }
    await runUnattendedCleanup(cleaners, session)
    const log = await readFile(session.audit.path, 'utf8')
    return { session, removedTargets: log.match(/"entry-removed"/g) ?? [], log }
}

describe('dry run per cleanup category', () => {
    test('general cache cleanup previews regenerable caches without removing them', async () => {
        const codex = await sandbox.file(join(home, '.codex', 'cache', 'codex_apps_tools', 't.json'))
        const discord = await sandbox.file(join(home, 'AppData', 'Roaming', 'discord', 'Cache', 'data_0'))
        const { session, removedTargets, log } = await dryRun('general-cache')
        expect([...session.selectedCleaners].toSorted()).toEqual(['codex', 'discord-cache'])
        expect(session.summary.detectedBytes).toBe(2)
        expect(removedTargets).toEqual([])
        expect(log).toContain('"dry-run-skip"')
        expect(await pathExists(codex)).toBe(true)
        expect(await pathExists(discord)).toBe(true)
    })

    test('destructive cache cleanup previews package caches without removing them', async () => {
        const npm = await sandbox.file(join(local, 'npm-cache', '_cacache', 'index-v5', '00'))
        const npx = await sandbox.file(join(local, 'npm-cache', '_npx', 'abc', 'package.json'))
        await sandbox.file(join(home, 'scoop', 'apps', 'scoop', 'current', 'scoop.ps1'))
        const scoop = await sandbox.file(join(home, 'scoop', 'cache', 'git#2.50.0#abc1234.7z'))
        const { session, removedTargets } = await dryRun('destructive-cache')
        expect([...session.selectedCleaners].toSorted()).toEqual(['npm-cache', 'scoop-cache'])
        expect(removedTargets).toEqual([])
        for (const path of [npm, npx, scoop]) expect(await pathExists(path)).toBe(true)
    })

    test('old-installation cleanup previews superseded releases without removing them', async () => {
        const app = join(local, 'GitHubDesktop')
        await sandbox.file(join(app, 'Update.exe'))
        await sandbox.file(join(app, 'packages', 'RELEASES'), `${'a'.repeat(40)} GitHubDesktop-3.4.0-full.nupkg 1234\n`)
        for (const version of ['3.4.0', '3.3.0']) {
            await sandbox.file(join(app, `app-${version}`, 'GitHubDesktop.exe'))
        }
        const superseded = await sandbox.file(join(app, 'app-3.2.0', 'GitHubDesktop.exe'))
        const { session, removedTargets, log } = await dryRun('old-installations')
        expect([...session.selectedCleaners]).toEqual(['github-desktop-versions'])
        expect(log).toContain('GitHub Desktop 3.2.0')
        expect(log).not.toContain('GitHub Desktop 3.3.0')
        expect(removedTargets).toEqual([])
        expect(await pathExists(superseded)).toBe(true)
    })

    test('old-installation cleanup previews latest-only Codex cleanup per release store', async () => {
        const inUse = await addCodexRelease(sandbox, 'standalone', '0.160.0')
        const rollback = await addCodexRelease(sandbox, 'standalone', '0.165.0')
        const selected = await addCodexRelease(sandbox, 'standalone', '0.167.0')
        await selectCodexRelease(sandbox, 'standalone', '0.167.0')
        await sandbox.file(codexStorePath('standalone', 'selection-history'), `${selected}\n${rollback}\n`)
        const daemonOld = await addCodexRelease(sandbox, 'app-server-daemon', '0.169.1')
        const daemonSelected = await addCodexRelease(sandbox, 'app-server-daemon', '0.172.0')
        const daemonStaged = await addCodexRelease(sandbox, 'app-server-daemon', '0.173.0')
        await selectCodexRelease(sandbox, 'app-server-daemon', '0.172.0')
        await sandbox.file(codexStorePath('app-server-daemon', 'auto-update-version'), daemonStaged)
        runningProcesses.push({
            id: 2,
            name: 'codex.exe',
            path: join(sandbox.root, codexStorePath('standalone', 'releases', inUse, 'bin', 'codex.exe'))
        })

        const { log, removedTargets } = await dryRun('old-installations')
        const previewed = [...log.matchAll(/"candidate":"Codex ([^"]+)"/g)].map((match) => match[1] ?? '')
        expect(previewed.toSorted((left, right) => left.localeCompare(right))).toEqual([`app-server-daemon ${daemonOld}`, `standalone ${rollback}`])
        expect(log).not.toContain(daemonSelected + '"')
        expect(removedTargets).toEqual([])
    })
})
