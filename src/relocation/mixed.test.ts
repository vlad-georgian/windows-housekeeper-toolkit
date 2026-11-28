import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { chmod, link, lstat, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { entryIdentity, pathExists } from '../core/filesystem/paths.ts'
import { cancelled } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { isolatedPackageSources } from '../test-support/package-sources.ts'
import { rejection } from '../test-support/rejection.ts'
import { createRelocationCatalog } from './apps/index.ts'
import { inspectApp, inspectPath, moveSteps } from './inspect.ts'
import { createRecoveryJournal } from './journal.ts'
import { createRelocationOperation } from './operation.ts'
import { DestinationConflictError, IncompleteTransferError, moveDirectory, restoreDirectory } from './transfer.ts'

setDefaultTimeout(30_000)

let sandbox: Sandbox
beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(async () => sandbox.dispose())

test('a release junction tracks the live release and hard-link aliases count once', async () => {
    const original = await sandbox.directory('Users/test/.codex')
    const release = await sandbox.directory('Users/test/.codex/packages/standalone/releases/v1')
    const exe = join(release, 'codex.exe')
    await writeFile(exe, 'v1')
    await link(exe, join(release, 'alias.exe'))
    await symlink(exe, join(release, 'symbolic.exe'), 'file')
    await symlink(release, join(original, 'packages', 'standalone', 'current'), 'junction')
    const bin = await sandbox.directory('Users/test/.codex/bin')
    const chained = join(bin, 'codex.exe')
    await symlink(join(original, 'packages', 'standalone', 'current', 'symbolic.exe'), chained, 'file')
    const base = await sandbox.directory('Other')
    const transfer = { appId: 'codex', original, destination: join(base, 'test', '.codex'), base }
    const options = { journal: createRecoveryJournal(sandbox.paths) }
    const current = join(original, 'packages', 'standalone', 'current', 'codex.exe')
    expect(await moveDirectory(transfer, options)).toEqual({ bytes: 2, files: 1 })
    expect(await readFile(chained, 'utf8')).toBe('v1')
    expect(await readFile(current, 'utf8')).toBe('v1')
    await writeFile(current, 'latest')
    expect((await stat(exe, { bigint: true })).ino).toBe((await stat(join(release, 'alias.exe'), { bigint: true })).ino)
    await restoreDirectory(transfer, options)
    expect(await readFile(chained, 'utf8')).toBe('latest')
    expect(await readFile(current, 'utf8')).toBe('latest')
    expect((await lstat(join(release, 'symbolic.exe'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(release, 'symbolic.exe'), 'utf8')).toBe('latest')
    expect((await lstat(join(original, 'packages', 'standalone', 'current'))).isSymbolicLink()).toBe(true)
})

test('consolidates a mixed Claude Code profile and restores the latest data at each original name', async () => {
    const versions = await sandbox.directory('Users/test/.local/share/claude/versions')
    const version = join(versions, '2.1.0')
    await writeFile(version, 'native')
    const bin = await sandbox.directory('Users/test/.local/bin')
    const launcher = join(bin, 'claude.exe')
    await link(version, launcher)
    const unrelated = await sandbox.file('Users/test/.local/bin/other.exe', 'other')
    const old = await sandbox.directory('Previous/test/.claude')
    await writeFile(join(old, 'settings.json'), '{}')
    const data = join(sandbox.paths.home, '.claude')
    await symlink(old, data, 'junction')
    const otherConsumer = join(sandbox.root, 'another-consumer')
    await symlink(old, otherConsumer, 'junction')
    const config = await sandbox.file('Other/test/.claude.json', '{}')
    const configLink = join(sandbox.paths.home, '.claude.json')
    await symlink(config, configLink, 'file')
    const configId = (await lstat(configLink, { bigint: true })).ino
    const base = join(sandbox.root, 'Other')
    const catalog = createRelocationCatalog(sandbox.paths, isolatedPackageSources)
    const operation = createRelocationOperation({
        catalog,
        home: sandbox.paths.home,
        journal: createRecoveryJournal(sandbox.paths),
        dryRun: false,
        listProcesses: async () => [],
        driveType: async () => 'fixed',
        volumesDiffer: async () => true,
        report: async (event) => {
            if (event.kind === 'failed') throw event.error
        }
    })
    const prompts = new FakePrompts([['claude-code'], base])
    const move = await operation.gather(prompts)
    if (!move || move === cancelled) throw new Error('Missing move plan')
    expect(prompts.checklists[0]?.initialValues).toEqual([])
    expect(move.lines.find((line) => line.includes(launcher))).toContain('(0 B)')
    await move.apply()
    expect((await lstat(configLink, { bigint: true })).ino).toBe(configId)
    expect((await lstat(launcher)).isSymbolicLink()).toBe(true)
    expect((await stat(launcher, { bigint: true })).ino).toBe((await stat(version, { bigint: true })).ino)
    expect(await readFile(join(otherConsumer, 'settings.json'), 'utf8')).toBe('{}')
    await writeFile(join(data, 'settings.json'), 'latest')
    await writeFile(launcher, 'v2')
    const reverse = new FakePrompts([[]])
    const restore = await operation.gather(reverse)
    if (!restore || restore === cancelled) throw new Error('Missing restore plan')
    expect(reverse.checklists[0]?.initialValues).toEqual(['claude-code'])
    await restore.apply()
    expect(await readFile(join(data, 'settings.json'), 'utf8')).toBe('latest')
    expect(await readFile(version, 'utf8')).toBe('v2')
    expect((await stat(launcher, { bigint: true })).ino).toBe((await stat(version, { bigint: true })).ino)
    expect((await lstat(launcher)).isSymbolicLink()).toBe(false)
    expect(await readFile(unrelated, 'utf8')).toBe('other')
    expect(await readFile(config, 'utf8')).toBe('{}')
})

test('preserves the identity of a pre-existing file symlink on a racing destination', async () => {
    const source = await sandbox.file('Previous/test/.claude.json', '{}')
    const original = join(sandbox.paths.home, '.claude.json')
    await symlink(source, original, 'file')
    const seen = await inspectPath(original, 'file')
    if (seen.kind !== 'linked') throw new Error('Expected a file symlink')
    const base = await sandbox.directory('Other')
    const destination = join(base, 'test', '.claude.json')
    const journal = createRecoveryJournal(sandbox.paths)
    const error = await rejection(
        moveDirectory(
            { appId: 'claude-code', kind: 'file', original, destination, base, originalLink: seen },
            {
                journal,
                async beforePhase(phase) {
                    if (phase === 'swapping') {
                        expect((await journal.list())[0]?.originalLink).toMatchObject({ target: source, identity: seen.identity, targetIdentity: seen.targetIdentity })
                        await writeFile(destination, 'keep')
                    }
                }
            }
        )
    )
    expect(error).toBeInstanceOf(DestinationConflictError)
    expect(await inspectPath(original, 'file')).toEqual(seen)
    expect(await readFile(destination, 'utf8')).toBe('keep')
})

test('reclaims a recorded older mirror and keeps other consumers on the live data through restoration', async () => {
    const original = await sandbox.directory('Users/test/.codex')
    await sandbox.file('Users/test/.codex/config.toml', 'first')
    const base = await sandbox.directory('Old')
    const destination = join(base, 'test', '.codex')
    const journal = createRecoveryJournal(sandbox.paths)
    const transfer = { appId: 'codex', original, destination, base }
    await moveDirectory(transfer, { journal })
    const second = join(sandbox.root, 'consumer')
    await symlink(destination, second, 'junction')
    const seen = await inspectPath(original)
    if (seen.kind !== 'linked') throw new Error('Missing original link')
    const nextBase = join(sandbox.root, 'New')
    const next = { ...transfer, base: nextBase, destination: join(nextBase, 'test', '.codex') }
    await moveDirectory({ ...next, originalLink: seen }, { journal })
    expect((await lstat(destination)).isSymbolicLink()).toBe(true)
    await writeFile(join(second, 'config.toml'), 'latest')
    await restoreDirectory(next, { journal })
    expect(await readFile(join(original, 'config.toml'), 'utf8')).toBe('latest')
    expect(await readFile(join(second, 'config.toml'), 'utf8')).toBe('latest')
})

test('recognizes linked desktop data with a verified legacy layout', async () => {
    const old = await sandbox.directory('Legacy/Claude-Data')
    await sandbox.file('Legacy/Claude-Data/Claude_pzs8sxrjxfjjc/claude_desktop_config.json', '{}')
    const data = join(sandbox.paths.localAppData, 'Claude-Data')
    await symlink(old, data, 'junction')
    const app = createRelocationCatalog(sandbox.paths, isolatedPackageSources).find((entry) => entry.id === 'claude-desktop')
    if (!app) throw new Error('Missing catalog entry')
    const inspection = await inspectApp(app, sandbox.paths.home)
    if ('blocked' in inspection) throw new Error(inspection.blocked)
    const [step] = moveSteps(inspection, join(sandbox.root, 'New'), sandbox.paths.home)
    expect(step).toMatchObject({ kind: 'move', path: data, originalLink: { target: old } })
})

test('an unrelated launcher at the conventional filename blocks the app', async () => {
    await sandbox.file('Users/test/.local/share/claude/versions/2.1.0', 'release')
    const launcher = await sandbox.file('Users/test/.local/bin/claude.exe', 'unknown')
    const app = createRelocationCatalog(sandbox.paths, isolatedPackageSources).find((entry) => entry.id === 'claude-code')
    if (!app) throw new Error('Missing catalog entry')
    const inspection = await inspectApp(app, sandbox.paths.home)
    expect(inspection).toEqual({ blocked: `Could not verify the app owns ${launcher}` })
})

test.each(['move', 'restore'] as const)('undoes a file %s when removing the staging alias fails', async (action) => {
    const original = await sandbox.file('Users/test/.claude.json', 'keep')
    const base = await sandbox.directory('Other')
    const destination = join(base, 'test', '.claude.json')
    const journal = createRecoveryJournal(sandbox.paths)
    const transfer = { appId: 'claude-code', original, base, destination, kind: 'file' as const }
    const options = {
        journal,
        async removeStagingAlias(staging: string) {
            expect(await readFile(action === 'move' ? destination : original, 'utf8')).toBe('keep')
            expect(await pathExists(staging)).toBe(true)
            throw new Error('staging alias removal failed')
        }
    }
    if (action === 'restore') await moveDirectory(transfer, { journal })
    const prior = await lstat(original, { bigint: true })
    const run = action === 'move' ? moveDirectory : restoreDirectory
    expect(await rejection(run(transfer, options))).toHaveProperty('message', 'staging alias removal failed')
    const restored = await lstat(original, { bigint: true })
    expect(restored.dev).toBe(prior.dev)
    expect(restored.ino).toBe(prior.ino)
    expect(restored.isSymbolicLink()).toBe(prior.isSymbolicLink())
    expect(await readFile(original, 'utf8')).toBe('keep')
    expect(await pathExists(destination)).toBe(action === 'restore')
    expect(await journal.list()).toEqual([])
})

test('a file written at the original during rollback is kept and recovery is retained', async () => {
    const original = await sandbox.file('Users/test/.claude.json', 'keep')
    const base = await sandbox.directory('Other')
    const destination = join(base, 'test', '.claude.json')
    const journal = createRecoveryJournal(sandbox.paths)
    const transfer = { appId: 'claude-code', original, base, destination, kind: 'file' as const }
    await moveDirectory(transfer, { journal })
    const error = await rejection(
        restoreDirectory(transfer, {
            journal,
            async removeStagingAlias() {
                throw new Error('staging alias removal failed')
            },
            async beforeMove(from, to) {
                if (to === original && from.endsWith('.aside')) await writeFile(original, 'written by the app')
            }
        })
    )
    expect(error).toBeInstanceOf(IncompleteTransferError)
    expect(await readFile(original, 'utf8')).toBe('written by the app')
    const [record] = await journal.list()
    expect(record).toMatchObject({ action: 'restore', original, destination })
    expect((await lstat(record?.aside ?? '')).isSymbolicLink()).toBe(true)
    expect(await readFile(destination, 'utf8')).toBe('keep')
})

test('a destination replaced while recording ownership keeps recovery and stays unowned', async () => {
    const original = await sandbox.file('Users/test/.claude.json', 'primary')
    const base = await sandbox.directory('Other')
    const destination = join(base, 'test', '.claude.json')
    const saved = join(sandbox.root, 'saved')
    const journal = createRecoveryJournal(sandbox.paths)
    const transfer = { appId: 'claude-code', original, base, destination, kind: 'file' as const }
    const error = await rejection(
        moveDirectory(transfer, {
            journal: {
                ...journal,
                async setOwner(path, owner) {
                    await rename(destination, saved)
                    await writeFile(destination, 'replacement')
                    await journal.setOwner(path, owner)
                }
            }
        })
    )
    expect(error).toBeInstanceOf(IncompleteTransferError)
    expect(await journal.list()).toMatchObject([{ phase: 'reclaiming', original, destination }])
    expect((await journal.owner(original))?.identity).toBe(entryIdentity(await lstat(saved, { bigint: true })))
    await restoreDirectory(transfer, { journal })
    expect(await readFile(destination, 'utf8')).toBe('replacement')
    expect(await readFile(saved, 'utf8')).toBe('primary')
})

function relocationOperation() {
    return createRelocationOperation({
        catalog: createRelocationCatalog(sandbox.paths, isolatedPackageSources),
        home: sandbox.paths.home,
        journal: createRecoveryJournal(sandbox.paths),
        dryRun: false,
        listProcesses: async () => [],
        driveType: async () => 'fixed',
        volumesDiffer: async () => true,
        report: async () => {}
    })
}

async function plan(answers: ConstructorParameters<typeof FakePrompts>[0]) {
    const result = await relocationOperation().gather(new FakePrompts(answers))
    if (!result || result === cancelled) throw new Error('Missing relocation plan')
    return result
}

test('the Codex visible bin follows the selected store and a direct mirror consumer survives restore', async () => {
    const old = await sandbox.directory('Old/test/.codex')
    const release = await sandbox.directory('Old/test/.codex/packages/standalone/releases/v1/bin')
    await writeFile(join(release, 'codex.exe'), 'first')
    await symlink(join(release, '..'), join(old, 'packages', 'standalone', 'current'), 'junction')
    const installation = await sandbox.directory('Users/test/AppData/Local/Programs/OpenAI/Codex')
    const bin = join(installation, 'bin')
    await symlink(join(old, 'packages', 'standalone', 'current', 'bin'), bin, 'junction')
    const original = join(sandbox.paths.home, '.codex')
    await symlink(old, original, 'junction')
    const base = await sandbox.directory('New')
    await (await plan([['codex'], base])).apply()

    const current = join(original, 'packages', 'standalone', 'current', 'bin', 'codex.exe')
    const visible = join(bin, 'codex.exe')
    await writeFile(current, 'moved')
    expect(await readFile(visible, 'utf8')).toBe('moved')
    expect(await readFile(join(release, 'codex.exe'), 'utf8')).toBe('first')
    const consumer = join(sandbox.root, 'consumer')
    const mirror = join(base, 'test', '.codex')
    await symlink(mirror, consumer, 'junction')

    await (await plan([[]])).apply()
    await writeFile(current, 'restored')
    expect(await readFile(visible, 'utf8')).toBe('restored')
    expect(await readFile(join(consumer, 'packages', 'standalone', 'current', 'bin', 'codex.exe'), 'utf8')).toBe('restored')
    expect((await lstat(original)).isSymbolicLink()).toBe(false)

    await (await plan([['codex'], base])).apply()
    expect(await readFile(visible, 'utf8')).toBe('restored')
    expect((await lstat(mirror)).isSymbolicLink()).toBe(false)
})

test('resuming a partial Claude Code restore rejoins the two hard-linked names', async () => {
    const version = await sandbox.file('Users/test/.local/share/claude/versions/2.1.0', 'native')
    const bin = await sandbox.directory('Users/test/.local/bin')
    const launcher = join(bin, 'claude.exe')
    await link(version, launcher)
    const base = await sandbox.directory('New')
    await (await plan([['claude-code'], base])).apply()

    const restore = await plan([[]])
    const mirror = join(base, 'test', '.local', 'bin', 'claude.exe')
    const saved = join(sandbox.root, 'saved-launcher.exe')
    await rename(mirror, saved)
    await restore.apply()
    expect((await lstat(join(sandbox.paths.home, '.local', 'share', 'claude'))).isSymbolicLink()).toBe(false)
    await rename(saved, mirror)

    await (await plan([[]])).apply()
    expect((await lstat(launcher)).isSymbolicLink()).toBe(false)
    expect((await stat(version, { bigint: true })).ino).toBe((await stat(launcher, { bigint: true })).ino)
})

test('Claude Code can relocate a launcher symlink to its selected native store', async () => {
    const version = await sandbox.file('Users/test/.local/share/claude/versions/2.1.0', 'native')
    const bin = await sandbox.directory('Users/test/.local/bin')
    const launcher = join(bin, 'claude.exe')
    await symlink(version, launcher, 'file')
    const base = await sandbox.directory('New')
    await (await plan([['claude-code'], base])).apply()
    expect(await readFile(launcher, 'utf8')).toBe('native')
    expect((await stat(version, { bigint: true })).ino).toBe((await stat(launcher, { bigint: true })).ino)
    await (await plan([[]])).apply()
    expect(await readFile(launcher, 'utf8')).toBe('native')
    expect((await stat(version, { bigint: true })).ino).toBe((await stat(launcher, { bigint: true })).ino)
})

test('Claude Code rejects a launcher symlink to a matching file outside the native store', async () => {
    await sandbox.file('Users/test/.local/share/claude/versions/2.1.0', 'native')
    const other = await sandbox.file('Users/test/Other/claude.exe', 'native')
    const launcher = join(await sandbox.directory('Users/test/.local/bin'), 'claude.exe')
    await symlink(other, launcher, 'file')
    const base = await sandbox.directory('New')
    const prompts = new FakePrompts([['claude-code'], base])
    expect(await relocationOperation().gather(prompts)).toBeNull()
    expect(prompts.logs.join(' ')).toContain('outside a verified profile mirror')
    expect(await readFile(launcher, 'utf8')).toBe('native')
    expect(await pathExists(join(base, 'test'))).toBe(false)
})

test('reclaims verified hard-link names while leaving an outside alias readable', async () => {
    const root = await sandbox.directory('Users/test/alias-data')
    const first = await sandbox.file('Users/test/alias-data/first.txt', 'shared data')
    const second = join(root, 'second.txt')
    const outside = join(sandbox.root, 'outside.txt')
    await link(first, second)
    await link(first, outside)
    const base = await sandbox.directory('New')
    const destination = join(base, 'test', 'alias-data')
    const journal = createRecoveryJournal(sandbox.paths)

    expect(await moveDirectory({ appId: 'fixture', original: root, base, destination }, { journal })).toEqual({ bytes: 11, files: 1 })
    expect((await stat(join(root, 'first.txt'), { bigint: true })).ino).toBe((await stat(join(root, 'second.txt'), { bigint: true })).ino)
    expect(await readFile(outside, 'utf8')).toBe('shared data')
    expect((await stat(outside, { bigint: true })).nlink).toBe(1n)
    expect(await journal.list()).toEqual([])
})

test('a hard link added at the reclamation boundary preserves both copies and recovery', async () => {
    const root = await sandbox.directory('Users/test/alias-data')
    const first = await sandbox.file('Users/test/alias-data/first.txt', 'shared data')
    await link(first, join(root, 'second.txt'))
    const outside = join(sandbox.root, 'outside.txt')
    const base = await sandbox.directory('New')
    const destination = join(base, 'test', 'alias-data')
    const journal = createRecoveryJournal(sandbox.paths)
    const error = await rejection(
        moveDirectory(
            { appId: 'fixture', original: root, base, destination },
            {
                journal,
                async afterVerifyingSurvivor(record) {
                    if (!record.aside) throw new Error('Missing retiring path')
                    await link(join(record.aside, 'first.txt'), outside)
                }
            }
        )
    )
    expect(error).toBeInstanceOf(IncompleteTransferError)
    expect(error).toHaveProperty('message', expect.stringContaining('links'))
    const [record] = await journal.list()
    if (!record?.aside) throw new Error('Missing recovery record')
    expect(await readFile(join(record.aside, 'first.txt'), 'utf8')).toBe('shared data')
    expect(await readFile(join(record.aside, 'second.txt'), 'utf8')).toBe('shared data')
    expect(await readFile(outside, 'utf8')).toBe('shared data')
    expect(await readFile(join(destination, 'first.txt'), 'utf8')).toBe('shared data')
})

test('a substituted alias name keeps the replacement and the surviving copy', async () => {
    const root = await sandbox.directory('Users/test/alias-data')
    const first = await sandbox.file('Users/test/alias-data/first.txt', 'shared data')
    await link(first, join(root, 'second.txt'))
    const base = await sandbox.directory('New')
    const destination = join(base, 'test', 'alias-data')
    const journal = createRecoveryJournal(sandbox.paths)
    const error = await rejection(
        moveDirectory(
            { appId: 'fixture', original: root, base, destination },
            {
                journal,
                async afterVerifyingSurvivor(record) {
                    if (!record.aside) throw new Error('Missing retiring path')
                    const name = join(record.aside, 'second.txt')
                    await rename(name, join(record.aside, 'displaced.txt'))
                    await writeFile(name, 'shared data')
                }
            }
        )
    )
    expect(error).toBeInstanceOf(IncompleteTransferError)
    const [record] = await journal.list()
    if (!record?.aside) throw new Error('Missing recovery record')
    const stillShared = await stat(join(record.aside, 'first.txt'), { bigint: true })
    expect(stillShared.ino).toBe((await stat(join(record.aside, 'displaced.txt'), { bigint: true })).ino)
    expect(stillShared.ino).not.toBe((await stat(join(record.aside, 'second.txt'), { bigint: true })).ino)
    expect(await readFile(join(destination, 'second.txt'), 'utf8')).toBe('shared data')
})

test('guarded file publication keeps the read-only attribute on the surviving file', async () => {
    const original = await sandbox.file('Users/test/.claude.json', 'settings')
    const base = await sandbox.directory('New')
    const destination = join(base, 'test', '.claude.json')
    const transfer = { appId: 'claude-code', original, destination, base, kind: 'file' as const }
    const journal = createRecoveryJournal(sandbox.paths)
    await chmod(original, 0o444)
    try {
        await moveDirectory(transfer, { journal })
        expect((await lstat(destination)).mode & 0o200).toBe(0)
        await restoreDirectory(transfer, { journal })
        expect((await lstat(original)).mode & 0o200).toBe(0)
        expect(await readFile(original, 'utf8')).toBe('settings')
        expect(await journal.list()).toEqual([])
    } finally {
        if (await pathExists(original)) await chmod(original, 0o666)
    }
})
