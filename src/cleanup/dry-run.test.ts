import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCleaners } from '../cleaners/index.ts'
import { ClaudeCodeInstallationCleaner } from '../cleaners/installations/claude-code-cleaner.ts'
import { CodexInstallationCleaner } from '../cleaners/installations/codex-cleaner.ts'
import { VitePlusInstallationCleaner } from '../cleaners/installations/vite-plus-cleaner.ts'
import { AuditLogger } from '../core/audit-logger.ts'
import { pathExists } from '../core/filesystem/index.ts'
import type { AppCleaner, CleanupCategoryId } from '../core/types.ts'
import { addCodexRelease, codexStorePath, selectCodexRelease } from '../test-support/codex-fixtures.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { addVitePlusRelease, selectVitePlusRelease, vitePlusSplitData } from '../test-support/vite-plus-fixtures.ts'
import type { WindowsProcess } from '../windows/processes.ts'
import { cleanersForCategories } from './categories.ts'
import { type CleanupSession, runUnattendedCleanup } from './operations.ts'
import { newSummary } from './summary.ts'

// Overrides that would point cleaners at real locations instead of the sandbox.
const overrides = ['CODEX_HOME', 'SCOOP', 'SCOOP_CACHE', 'BUN_INSTALL', 'BUN_INSTALL_CACHE_DIR', 'ChocolateyInstall', 'VP_HOME', 'VP_BIN_DIR', 'VP_DATA_DIR', 'VP_CACHE_DIR']
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

/** Replaces cleaners that query live processes or the native launcher with scripted ones. */
const processes = async (): Promise<WindowsProcess[]> => runningProcesses

function scripted(cleaner: AppCleaner): AppCleaner {
    if (cleaner.id === 'codex-releases') return new CodexInstallationCleaner(sandbox.paths, processes)
    if (cleaner.id === 'vite-plus-releases') return new VitePlusInstallationCleaner(sandbox.paths, {}, processes)
    if (cleaner.id === 'claude-code-versions') {
        return new ClaudeCodeInstallationCleaner(sandbox.paths, async () => ({ exitCode: 0, stdout: '2.1.326 (Claude Code)', stderr: '' }), processes)
    }
    return cleaner
}

async function dryRun(category: CleanupCategoryId): Promise<{
    session: CleanupSession
    removedTargets: string[]
    log: string
}> {
    const cleaners = cleanersForCategories(createCleaners(sandbox.paths), [category])
        .filter((cleaner) => !liveSystemCleaners.has(cleaner.id))
        .map((cleaner) => scripted(cleaner))
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

    test('Windows temporary directory cleanup previews per-user contents without removing them', async () => {
        const temp = await sandbox.file(join(local, 'Temp', 'installer', 'setup.tmp'), 'abc')
        const internet = await sandbox.file(join(local, 'Microsoft', 'Windows', 'INetCache', 'IE', 'page.htm'), 'de')
        const machineWide = await sandbox.file(join('Windows', 'Temp', 'machine.tmp'))
        const { session, removedTargets, log } = await dryRun('windows-temp')
        expect([...session.selectedCleaners].toSorted()).toEqual(['internet-cache', 'user-temp'])
        expect(session.summary.detectedBytes).toBe(5)
        expect(removedTargets).toEqual([])
        expect(log).toContain('"dry-run-skip"')
        expect(log).not.toContain('machine.tmp')
        for (const path of [temp, internet, machineWide]) expect(await pathExists(path)).toBe(true)
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

    test('old-installation cleanup previews obsolete Vite+, Claude Code, and VS Code data and preserves the rest', async () => {
        // Releases are pnpm installs in the split data directory, and Vite+ 1.7 or later keeps an installation lock there.
        for (const version of ['1.7.0', '1.8.0', '1.9.0', '1.10.0']) await addVitePlusRelease(sandbox, version, vitePlusSplitData)
        await selectVitePlusRelease(sandbox, '1.9.0', vitePlusSplitData)
        await sandbox.file(join(vitePlusSplitData, '.previous-version'), '1.8.0')
        await sandbox.file(join(vitePlusSplitData, '.install.lock'), '')

        const claude = join(home, '.local', 'share', 'claude', 'versions')
        for (const version of ['2.1.325', '2.1.326', '2.1.327']) await sandbox.file(join(claude, version))
        await sandbox.file(join(home, '.local', 'bin', 'claude.exe'))

        const extensions = join(home, '.vscode', 'extensions')
        for (const folder of ['a.old-1.0.0', 'a.old-2.0.0', 'b.ext-1.0.0']) await sandbox.file(join(extensions, folder, 'package.json'), '{}')
        await sandbox.file(join(extensions, 'extensions.json'), JSON.stringify([{ relativeLocation: 'a.old-2.0.0' }, { relativeLocation: 'b.ext-1.0.0' }]))
        await sandbox.file(join(extensions, '.obsolete'), JSON.stringify({ 'a.old-1.0.0': true, 'a.old-2.0.0': true }))

        const { session, log, removedTargets } = await dryRun('old-installations')
        const previewed = [...log.matchAll(/"candidate":"([^"]+)"/g)].map((match) => match[1] ?? '').toSorted()
        expect([...session.selectedCleaners].toSorted()).toEqual(['claude-code-versions', 'vite-plus-releases', 'vscode-extensions'])
        expect(previewed).toEqual(['Claude Code 2.1.325', 'VS Code extension a.old-1.0.0', 'Vite+ 1.7.0'])
        expect(removedTargets).toEqual([])
        for (const path of [join(vitePlusSplitData, '1.7.0'), join(claude, '2.1.325'), join(extensions, 'a.old-1.0.0')]) {
            expect(await pathExists(join(sandbox.root, path))).toBe(true)
        }
    })
})
