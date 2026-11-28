import { afterEach, beforeEach, expect, test } from 'bun:test'
import { link, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cancelled, type PlanSection } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { rejection } from '../test-support/rejection.ts'
import { windowsDriveType } from '../windows/drives.ts'
import type { WindowsProcess } from '../windows/processes.ts'
import { createRelocationCatalog } from './apps/index.ts'
import type { PackageEnvironment } from './apps/package-evidence.ts'
import { createRecoveryJournal } from './journal.ts'
import { differentVolumes } from './layout.ts'
import { createRelocationOperation, type RelocationEvent, toolkitProcessIds } from './operation.ts'
import { DestinationConflictError, moveDirectory, UnsupportedTreeError } from './transfer.ts'
import { inconsistentLink, type TreeManifest } from './tree.ts'
import type { RelocatableApp } from './types.ts'

// Each full move or restore reads Windows permissions through PowerShell several times.
const transferTimeout = 120_000
const otherVolume = process.env.HOUSEKEEPER_TEST_OTHER_VOLUME
let sandbox: Sandbox
let disposableDestination: string | undefined

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(async () => {
    await sandbox.dispose()
    if (disposableDestination) await rm(disposableDestination, { recursive: true, force: true })
    disposableDestination = undefined
})

function planned(result: PlanSection | null | typeof cancelled): PlanSection {
    if (!result || result === cancelled) throw new Error('Expected a relocation plan')
    return result
}

interface Fixture {
    readonly env?: PackageEnvironment
    readonly machineChocolatey?: string | null | undefined
    readonly processes?: readonly WindowsProcess[]
    readonly extra?: readonly RelocatableApp[]
    readonly crossVolume?: boolean
}

/** An operation over the real catalog in the sandbox. Failed transfers are collected, not thrown. */
function relocation({ env = {}, machineChocolatey, processes = [], extra = [], crossVolume = false }: Fixture = {}) {
    const events: RelocationEvent[] = []
    const operation = createRelocationOperation({
        catalog: [...createRelocationCatalog(sandbox.paths, { env, machineChocolatey: async () => machineChocolatey }), ...extra],
        home: sandbox.paths.home,
        journal: createRecoveryJournal(sandbox.paths),
        dryRun: false,
        listProcesses: async () => processes,
        volumesDiffer: crossVolume ? differentVolumes : async () => true,
        driveType: crossVolume ? windowsDriveType : async () => 'fixed',
        report: async (event) => {
            events.push(event)
        }
    })
    return { operation, events }
}

/** A per-user Scoop with its own launcher release, `current` junction and one persisted app. */
async function scoopLayout() {
    const manager = await sandbox.directory('Users/test/scoop/apps/scoop/1')
    const launcher = await sandbox.file('Users/test/scoop/apps/scoop/1/bin/scoop.ps1', '# Scoop fixture')
    await symlink(manager, join(manager, '..', 'current'), 'junction')
    const persist = await sandbox.directory('Users/test/scoop/persist/foo')
    const foo = await sandbox.directory('Users/test/scoop/apps/foo/1')
    await symlink(foo, join(foo, '..', 'current'), 'junction')
    await symlink(persist, join(foo, 'data'), 'junction')
    const root = join(sandbox.paths.home, 'scoop')
    return { root, apps: join(root, 'apps'), launcher, persist, foo }
}

/** npm with one global package and a content cache under the default per-user locations. */
async function npmLayout() {
    await sandbox.file('Users/test/AppData/Roaming/npm/node_modules/tool/package.json', '{"name":"tool","version":"1.0.0"}')
    await sandbox.directory('Users/test/AppData/Local/npm-cache/_cacache/content-v2')
    await sandbox.directory('Users/test/AppData/Local/npm-cache/_cacache/index-v5')
    return {
        globals: join(sandbox.paths.roamingAppData, 'npm', 'node_modules'),
        cache: join(sandbox.paths.localAppData, 'npm-cache', '_cacache')
    }
}

async function inode(path: string): Promise<bigint> {
    return (await lstat(path, { bigint: true })).ino
}

test(
    'Scoop moves its whole root once, and apps keep one persistent directory and new persisted hard links',
    async () => {
        const manager = await sandbox.directory('Users/test/scoop/apps/scoop/1')
        await sandbox.file('Users/test/scoop/apps/scoop/1/bin/scoop.ps1', '# Scoop fixture')
        await symlink(manager, join(manager, '..', 'current'), 'junction')
        const shared = await sandbox.directory('Users/test/scoop/persist/shared')
        const configuration = await sandbox.file('Users/test/scoop/persist/shared/settings.txt', 'original')
        const node = await sandbox.directory('Users/test/scoop/apps/nodejs/26')
        await sandbox.file('Users/test/scoop/apps/nodejs/26/node.exe', 'fixture executable')
        await sandbox.file('Users/test/scoop/apps/nodejs/26/node_modules/tool/package.json', '{"name":"tool","version":"1.0.0"}')
        const second = await sandbox.directory('Users/test/scoop/apps/second/1')
        const launcher = await sandbox.file('Users/test/scoop/shims/node.shim', `path = "${join(node, 'node.exe')}"`)
        for (const app of [node, second]) await symlink(shared, join(app, 'data'), 'junction')
        const outsideConsumer = join(sandbox.root, 'shared-consumer')
        await symlink(shared, outsideConsumer, 'junction')

        disposableDestination = otherVolume ? await mkdtemp(join(otherVolume, 'housekeeper-test-')) : undefined
        const base = join(disposableDestination ?? sandbox.root, 'Software')
        const root = join(sandbox.paths.home, 'scoop')
        const apps = join(root, 'apps')
        const { operation, events } = relocation({
            env: { NPM_CONFIG_PREFIX: node },
            crossVolume: !!otherVolume,
            extra: [{ id: 'duplicate', label: 'Duplicate app root', processGuardId: 'scoop-relocation', paths: [{ path: apps, description: 'duplicate' }] }]
        })
        const select = new FakePrompts([['scoop', 'npm', 'nodejs', 'duplicate'], base])
        const move = planned(await operation.gather(select))
        expect(select.checklists[0]?.options.map(({ value }) => value)).toEqual(['scoop'])
        expect(move.lines.filter((line) => line.includes('→'))).toEqual([expect.stringContaining(`  ${root} → ${join(base, 'test', 'scoop')}`)])
        await move.apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect(await realpath(root)).toBe(join(base, 'test', 'scoop'))
        expect(await realpath(apps)).toBe(join(base, 'test', 'scoop', 'apps'))
        expect(await readFile(join(node, 'node.exe'), 'utf8')).toBe('fixture executable')
        expect(await readFile(launcher, 'utf8')).toContain(join(node, 'node.exe'))
        await writeFile(join(node, 'data', 'settings.txt'), 'latest')
        expect(await readFile(join(second, 'data', 'settings.txt'), 'utf8')).toBe('latest')
        expect(await readFile(join(outsideConsumer, 'settings.txt'), 'utf8')).toBe('latest')

        // A later `scoop install` hard-links a persisted file from the version into `persist`.
        // Both names resolve to the base drive, so the link works across the original volume.
        const persisted = join(shared, 'app.ini')
        await writeFile(persisted, 'defaults')
        await link(persisted, join(node, 'app.ini'))
        await writeFile(join(node, 'app.ini'), 'user setting')
        expect(await readFile(persisted, 'utf8')).toBe('user setting')

        const clear = new FakePrompts([[]])
        const restore = planned(await operation.gather(clear))
        expect(clear.checklists[0]?.initialValues).toEqual(['scoop'])
        expect(restore.lines.filter((line) => line.includes('→'))).toHaveLength(1)
        await restore.apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect((await lstat(root)).isSymbolicLink()).toBe(false)
        expect(await realpath(join(node, 'data'))).toBe(shared)
        expect(await realpath(join(second, 'data'))).toBe(shared)
        expect(await readFile(join(outsideConsumer, 'settings.txt'), 'utf8')).toBe('latest')
        expect(await readFile(configuration, 'utf8')).toBe('latest')
        expect(await inode(join(node, 'app.ini'))).toBe(await inode(persisted))
        expect((await lstat(persisted)).nlink).toBe(2)
    },
    transferTimeout
)

test(
    'Scoop keeps a persisted file linked between apps and persist through move and restore',
    async () => {
        const { root, foo } = await scoopLayout()
        const persisted = await sandbox.file('Users/test/scoop/persist/foo/config.ini', 'original')
        await link(persisted, join(foo, 'config.ini'))
        const { operation, events } = relocation()

        await planned(await operation.gather(new FakePrompts([['scoop'], join(sandbox.root, 'Software')]))).apply()
        expect((await lstat(root)).isSymbolicLink()).toBe(true)
        expect(await inode(join(foo, 'config.ini'))).toBe(await inode(persisted))
        await writeFile(join(foo, 'config.ini'), 'moved edit')
        expect(await readFile(persisted, 'utf8')).toBe('moved edit')

        await planned(await operation.gather(new FakePrompts([[]]))).apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect((await lstat(root)).isSymbolicLink()).toBe(false)
        expect(await inode(join(foo, 'config.ini'))).toBe(await inode(persisted))
        expect((await lstat(persisted)).nlink).toBe(2)
    },
    transferTimeout
)

test('Scoop refuses to move a file hard-linked to a name outside its root', async () => {
    const { root, foo } = await scoopLayout()
    const outside = await sandbox.file('Users/test/Documents/config.ini', 'original')
    await link(outside, join(foo, 'config.ini'))
    const { operation } = relocation()
    const prompts = new FakePrompts([['scoop'], join(sandbox.root, 'Software')])

    expect(await operation.gather(prompts)).toBeNull()
    expect(prompts.logs.some((message) => message.includes(`${join(foo, 'config.ini')} is hard-linked to a name outside ${root}`))).toBe(true)
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    expect((await lstat(outside)).nlink).toBe(2)
})

test('Scoop leaves everything in place when an outside hard link appears before apply', async () => {
    const { root, foo } = await scoopLayout()
    const { operation, events } = relocation()
    const move = planned(await operation.gather(new FakePrompts([['scoop'], join(sandbox.root, 'Software')])))
    const outside = await sandbox.file('Users/test/Documents/config.ini', 'original')
    await link(outside, join(foo, 'config.ini'))

    await move.apply()

    expect(events).toMatchObject([{ kind: 'failed', appId: 'scoop', completed: [], notAttempted: [root] }])
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    await writeFile(join(foo, 'config.ini'), 'edited')
    expect(await readFile(outside, 'utf8')).toBe('edited')
})

test('the transfer refuses an outside hard link in the same snapshot it verifies', async () => {
    const { root, foo } = await scoopLayout()
    const outside = await sandbox.file('Users/test/Documents/config.ini', 'original')
    await link(outside, join(foo, 'config.ini'))
    const journal = createRecoveryJournal(sandbox.paths)
    const base = join(sandbox.root, 'Software')

    const error = await rejection(moveDirectory({ appId: 'scoop', original: root, destination: join(base, 'test', 'scoop'), base }, { journal, containedHardLinks: true }))

    expect(error).toBeInstanceOf(UnsupportedTreeError)
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    expect((await lstat(outside)).nlink).toBe(2)
    expect(await journal.list()).toEqual([])
})

test('Scoop stays in place when its launcher disappears before apply', async () => {
    const { root, launcher } = await scoopLayout()
    const { operation, events } = relocation()
    const move = planned(await operation.gather(new FakePrompts([['scoop'], join(sandbox.root, 'Software')])))
    await unlink(launcher)

    await move.apply()

    expect(events).toMatchObject([{ kind: 'failed', appId: 'scoop', action: 'move', original: root, completed: [] }])
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    expect(await realpath(root)).toBe(root)
})

test('an interrupted Scoop swap puts back the exact release and persist junctions', async () => {
    const { root, apps, persist, foo } = await scoopLayout()
    const identities = async () => Promise.all([root, join(apps, 'scoop', 'current'), join(foo, '..', 'current'), join(foo, 'data'), persist].map(inode))
    const before = await identities()
    const base = join(sandbox.root, 'Software')
    const journal = createRecoveryJournal(sandbox.paths)

    const error = await rejection(
        moveDirectory(
            { appId: 'scoop', original: root, destination: join(base, 'test', 'scoop'), base },
            {
                journal,
                containedHardLinks: true,
                async beforePhase(phase) {
                    if (phase === 'swapping') await sandbox.file('Software/test/scoop/racing-writer.txt', 'occupied')
                }
            }
        )
    )

    expect(error).toBeInstanceOf(DestinationConflictError)
    expect(await identities()).toEqual(before)
    expect(await realpath(join(foo, 'data'))).toBe(persist)
    expect(await journal.list()).toEqual([])
})

/** Marks a link itself read-only, as Scoop's `link_current` and `persist_data` do. */
function guardLink(path: string): void {
    const result = Bun.spawnSync(['attrib.exe', '+R', path, '/L'])
    if (result.exitCode !== 0) throw new Error(`attrib failed for ${path}`)
}

async function readOnlyLink(path: string): Promise<boolean> {
    const stats = await lstat(path)
    return stats.isSymbolicLink() && (stats.mode & 0o200) === 0
}

test(
    'Scoop restores after it relinks current and persisted data through the original path while relocated',
    async () => {
        const { root, apps, persist, foo } = await scoopLayout()
        for (const junction of [join(foo, '..', 'current'), join(foo, 'data')]) guardLink(junction)
        disposableDestination = otherVolume ? await mkdtemp(join(otherVolume, 'housekeeper-test-')) : undefined
        const base = join(disposableDestination ?? sandbox.root, 'Software')
        const mirror = join(base, 'test', 'scoop')
        const { operation, events } = relocation({ crossVolume: !!otherVolume })

        await planned(await operation.gather(new FakePrompts([['scoop'], base]))).apply()
        expect(await realpath(root)).toBe(mirror)
        for (const junction of [join(mirror, 'apps', 'foo', 'current'), join(mirror, 'apps', 'foo', '1', 'data')]) expect(await readOnlyLink(junction)).toBe(true)

        // `scoop update bar` while relocated: Scoop spells every new junction through its original root.
        const version = join(apps, 'bar', '2')
        await sandbox.file('Users/test/scoop/apps/bar/2/bar.exe', 'bar 2')
        await sandbox.directory('Users/test/scoop/persist/bar')
        await symlink(version, join(apps, 'bar', 'current'), 'junction')
        await symlink(join(root, 'persist', 'bar'), join(version, 'data'), 'junction')
        for (const junction of [join(apps, 'bar', 'current'), join(version, 'data')]) guardLink(junction)
        await writeFile(join(version, 'data', 'settings.ini'), 'bar settings')

        await planned(await operation.gather(new FakePrompts([[]]))).apply()

        expect(events.map((event) => event.kind)).toEqual(['moved', 'restored'])
        expect((await lstat(root)).isSymbolicLink()).toBe(false)
        expect(await readlink(join(apps, 'bar', 'current'))).toBe(version)
        expect(await realpath(join(apps, 'bar', 'current'))).toBe(version)
        expect(await realpath(join(version, 'data'))).toBe(join(root, 'persist', 'bar'))
        expect(await realpath(join(foo, 'data'))).toBe(persist)
        expect(await readFile(join(root, 'persist', 'bar', 'settings.ini'), 'utf8')).toBe('bar settings')
        for (const junction of [join(foo, '..', 'current'), join(foo, 'data'), join(apps, 'bar', 'current'), join(version, 'data')]) expect(await readOnlyLink(junction)).toBe(true)
        expect((await readdir(sandbox.paths.home)).filter((name) => name.includes('windows-housekeeper-toolkit'))).toEqual([])
        expect(await createRecoveryJournal(sandbox.paths).list()).toEqual([])
    },
    transferTimeout
)

test('a link the copy would classify differently is refused before anything is copied', () => {
    const finalRoot = join(sandbox.root, 'original')
    const entry = { identity: 'link', kind: 'junction' as const, bytes: 0, links: 1, hash: null, readOnly: false, alias: null }
    const manifest = (internal: boolean, target: string): TreeManifest => ({
        root: join(sandbox.root, 'mirror'),
        permissions: [],
        bytes: 0,
        files: 0,
        entries: [
            { ...entry, path: '', kind: 'directory', target: null, internal: false },
            { ...entry, path: 'current', target, internal }
        ]
    })

    expect(inconsistentLink(manifest(false, join(finalRoot, 'apps', '2')), finalRoot)).toBe(join(sandbox.root, 'mirror', 'current'))
    expect(inconsistentLink(manifest(true, join('apps', '2')), finalRoot)).toBeNull()
    expect(inconsistentLink(manifest(false, join(sandbox.root, 'elsewhere')), finalRoot)).toBeNull()
})

test(
    'a restore from receipts while Scoop’s configuration is unreadable still refuses outside hard links',
    async () => {
        const { root } = await scoopLayout()
        const persisted = await sandbox.file('Users/test/scoop/persist/foo/config.ini', 'original')
        const base = join(sandbox.root, 'Software')
        await planned(await relocation().operation.gather(new FakePrompts([['scoop'], base]))).apply()
        const outside = join(base, 'outside.ini')
        await link(persisted, outside)
        await sandbox.file('Users/test/.config/scoop/config.json', '{ broken')

        const { operation, events } = relocation()
        const prompts = new FakePrompts([[]])
        expect(await operation.gather(prompts)).toBeNull()

        expect(prompts.logs.some((message) => message.startsWith('Scoop cannot be restored: ') && message.includes('is hard-linked to a name outside'))).toBe(true)
        expect(events).toEqual([])
        expect((await lstat(root)).isSymbolicLink()).toBe(true)
        expect((await lstat(outside)).nlink).toBe(2)
    },
    transferTimeout
)

test('a custom Scoop root that holds more than Scoop is refused', async () => {
    const root = await sandbox.directory('Users/test/tools')
    await sandbox.file('Users/test/tools/apps/scoop/1/bin/scoop.ps1', '# Scoop fixture')
    await symlink(join(root, 'apps', 'scoop', '1'), join(root, 'apps', 'scoop', 'current'), 'junction')
    await sandbox.file('Users/test/tools/projects/app/readme.md', 'not Scoop')
    const prompts = new FakePrompts([[]])

    expect(await relocation({ env: { SCOOP: root } }).operation.gather(prompts)).toBeNull()
    expect(prompts.logs).toContain(`Scoop cannot be relocated. ${root} holds more than Scoop: projects`)
    expect(prompts.checklists).toHaveLength(0)
})

test(
    'a relocated npm path stays restorable after its last global package is removed',
    async () => {
        const { globals, cache } = await npmLayout()
        const base = join(sandbox.root, 'Software')
        const { operation, events } = relocation()
        await planned(await operation.gather(new FakePrompts([['npm'], base]))).apply()
        expect(await realpath(globals)).toBe(join(base, 'test', 'AppData', 'Roaming', 'npm', 'node_modules'))
        await rm(join(globals, 'tool'), { recursive: true })

        const reselect = new FakePrompts([['npm'], base])
        expect(await operation.gather(reselect)).toBeNull()
        expect(reselect.checklists[0]?.options.find(({ value }) => value === 'npm')?.hint).toContain(`${globals} no longer shows npm data`)

        const clear = new FakePrompts([[]])
        const restore = planned(await operation.gather(clear))
        expect(restore.lines.filter((line) => line.includes('→'))).toHaveLength(2)
        await restore.apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect(events.filter((event) => event.kind === 'restored').map((event) => event.kind === 'restored' && event.original)).toEqual([globals, cache])
        for (const path of [globals, cache]) expect(await realpath(path)).toBe(path)
    },
    transferTimeout
)

test('an unrecorded link with missing npm data is not offered as relocated', async () => {
    const backing = await sandbox.directory('Software/test/AppData/Roaming/npm/node_modules')
    await sandbox.directory('Users/test/AppData/Roaming/npm')
    await symlink(backing, join(sandbox.paths.roamingAppData, 'npm', 'node_modules'), 'junction')
    const prompts = new FakePrompts([[]])

    expect(await relocation().operation.gather(prompts)).toBeNull()
    expect(prompts.checklists).toHaveLength(0)
})

test(
    'npm restores the path it relocated after its configured prefix changes',
    async () => {
        const { globals, cache } = await npmLayout()
        const base = join(sandbox.root, 'Software')
        await planned(await relocation().operation.gather(new FakePrompts([['npm'], base]))).apply()
        await sandbox.file('Users/test/.npmrc', `prefix=${join(sandbox.paths.home, 'npm-global')}\n`)

        const { operation, events } = relocation()
        const clear = new FakePrompts([[]])
        const restore = planned(await operation.gather(clear))
        expect(clear.checklists[0]?.options.find(({ value }) => value === 'npm')?.hint).toContain(`${globals} no longer shows npm data`)
        expect(restore.lines.filter((line) => line.includes('→'))).toHaveLength(2)
        await restore.apply()

        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect(events.filter((event) => event.kind === 'restored').map((event) => event.kind === 'restored' && event.original)).toEqual([cache, globals])
        for (const path of [globals, cache]) expect(await realpath(path)).toBe(path)
    },
    transferTimeout
)

test(
    'npm stays restorable while its configuration blocks a new move',
    async () => {
        const { globals, cache } = await npmLayout()
        const base = join(sandbox.root, 'Software')
        await planned(await relocation().operation.gather(new FakePrompts([['npm'], base]))).apply()
        await sandbox.file('Users/test/.npmrc', 'prefix=${UNDEFINED_PREFIX}\\npm\n')

        const { operation, events } = relocation()
        const reselect = new FakePrompts([['npm'], base])
        expect(await operation.gather(reselect)).toBeNull()
        expect(reselect.logs).toContain(`npm cannot be relocated. ${join(sandbox.paths.home, '.npmrc')} refers to an undefined variable in prefix`)
        expect(reselect.logs).toContain("npm's relocated paths can still be restored. Leave it clear to restore them.")

        const restore = planned(await operation.gather(new FakePrompts([[]])))
        expect(restore.lines.filter((line) => line.includes('→'))).toHaveLength(2)
        await restore.apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        for (const path of [globals, cache]) expect(await realpath(path)).toBe(path)
        expect(await createRecoveryJournal(sandbox.paths).owners()).toEqual(new Map())
    },
    transferTimeout
)

test(
    'Bun moves its global packages and cache together and keeps their shared hard links',
    async () => {
        const global = await sandbox.directory('Users/test/.bun/install/global')
        await sandbox.file('Users/test/.bun/install/global/package.json', '{"dependencies":{"tool":"1.0.0"}}')
        await sandbox.file('Users/test/.bun/install/global/bun.lock', 'lock')
        const installed = await sandbox.file('Users/test/.bun/install/global/node_modules/tool/package.json', '{"name":"tool","version":"1.0.0"}')
        const cached = join(sandbox.paths.home, '.bun', 'install', 'cache', 'tool@1.0.0@@@1', 'package.json')
        await sandbox.directory('Users/test/.bun/install/cache/tool@1.0.0@@@1')
        await link(installed, cached)
        const project = await sandbox.directory('Users/test/projects/app/node_modules/tool')
        await link(installed, join(project, 'package.json'))
        const base = join(sandbox.root, 'Software')
        const { operation, events } = relocation()

        const move = planned(await operation.gather(new FakePrompts([['bun'], base])))
        expect(move.lines.filter((line) => line.includes('→'))).toHaveLength(2)
        expect(move.lines).toContain('    1 hard-linked file(s) (33 B) also have names outside these paths. Those names keep their own copies where they are.')
        await move.apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect((await realpath(global)).startsWith(base)).toBe(true)
        expect((await lstat(installed, { bigint: true })).ino).toBe((await lstat(cached, { bigint: true })).ino)
        expect((await lstat(installed)).nlink).toBe(2)
        expect(await readFile(join(project, 'package.json'), 'utf8')).toBe('{"name":"tool","version":"1.0.0"}')

        await planned(await operation.gather(new FakePrompts([[]]))).apply()
        expect(events.filter((event) => event.kind === 'failed')).toEqual([])
        expect(await realpath(global)).toBe(global)
        expect((await lstat(installed, { bigint: true })).ino).toBe((await lstat(cached, { bigint: true })).ino)
    },
    transferTimeout
)

test(
    'only verified user installations appear and standalone Node can move independently',
    async () => {
        const standalone = await sandbox.file('Users/test/AppData/Local/Programs/nodejs/node.exe', 'standalone')
        await sandbox.file('Users/test/AppData/Local/Programs/nodejs/node_modules/npm/package.json', '{"name":"npm","version":"11.0.0"}')
        await sandbox.file('Users/test/AppData/Local/Programs/nodejs/node_modules/npm/npmrc', 'prefix=${APPDATA}\\npm\n')
        await sandbox.file('Users/test/AppData/Local/nodejs/node.exe', 'unverified')
        const vp = await sandbox.file('Users/test/AppData/Local/vite-plus/bin/vp.exe', 'Vite+')
        const viteNode = await sandbox.file('Users/test/AppData/Local/vite-plus/data/js_runtime/node/26/node.exe', 'managed')
        await sandbox.file('Users/test/AppData/Local/vite-plus/data/1.5/package.json', '{"dependencies":{"vite-plus":"1.5.1"}}')
        await symlink(join(viteNode, '..', '..', '..', '..', '1.5'), join(viteNode, '..', '..', '..', '..', 'current'), 'junction')
        const npmLauncher = await sandbox.file('Users/test/AppData/Roaming/npm/tool.cmd', '@node "%~dp0node_modules/tool/cli.js"')
        const { globals } = await npmLayout()
        const npmPackage = join(globals, 'tool', 'package.json')
        const bunPackage = await sandbox.file('Users/test/.bun/install/global/package.json', '{"dependencies":{"tool":"1.0.0"}}')
        await sandbox.file('Users/test/.bun/install/global/bun.lock', 'lock')
        await sandbox.directory('Users/test/.bun/install/global/node_modules')
        const choco = await sandbox.directory('Users/test/chocolatey')
        await sandbox.file('Users/test/chocolatey/bin/choco.exe', 'per-user')
        await sandbox.file('Users/test/chocolatey/config/chocolatey.config', '<chocolatey />')
        await sandbox.file('Users/test/chocolatey/lib/chocolatey/chocolatey.nuspec', '<package/>')
        const machineDefault = await sandbox.directory('ProgramData/chocolatey')
        await sandbox.file('ProgramData/chocolatey/bin/choco.exe', 'machine-wide')
        await sandbox.file('ProgramData/chocolatey/config/chocolatey.config', '<chocolatey />')
        await sandbox.file('ProgramData/chocolatey/lib/chocolatey/chocolatey.nuspec', '<package/>')
        const base = join(sandbox.root, 'Software')
        // The toolkit runs as `vp run start` → `bun`. Its own launcher chain does not hold back Bun or Vite+.
        const processes: WindowsProcess[] = [
            { id: process.pid, name: 'bun.exe', path: null, commandLine: '"C:\\Tools\\bun.exe" run src/index.ts', parentId: 1101, createdAt: '2026-11-28T10:00:02Z' },
            { id: 1101, name: 'vp.exe', path: null, commandLine: '"C:\\Tools\\vp.exe" run start', parentId: 1100, createdAt: '2026-11-28T10:00:01Z' },
            { id: 1100, name: 'pwsh.exe', path: null, commandLine: 'pwsh', parentId: null, createdAt: '2026-11-28T10:00:00Z' }
        ]
        const operation = (env: PackageEnvironment, machineChocolatey?: string) => relocation({ env, machineChocolatey, processes })

        const first = operation({ ChocolateyInstall: choco })
        const prompts = new FakePrompts([['nodejs'], base])
        await planned(await first.operation.gather(prompts)).apply()
        expect(prompts.checklists[0]?.options.map(({ value }) => value).toSorted()).toEqual(['bun', 'chocolatey', 'nodejs', 'npm', 'vite-plus'])
        expect(await realpath(standalone)).toBe(join(base, 'test', 'AppData', 'Local', 'Programs', 'nodejs', 'node.exe'))
        expect(await realpath(viteNode)).toBe(viteNode)
        const machinePrompts = new FakePrompts([['nodejs']])
        expect(await operation({ ChocolateyInstall: machineDefault }).operation.gather(machinePrompts)).toBeNull()
        expect(machinePrompts.checklists[0]?.options.some(({ value }) => value === 'chocolatey')).toBe(false)
        const failedLookup = new FakePrompts([['nodejs']])
        expect(await relocation({ env: { ChocolateyInstall: choco }, machineChocolatey: null, processes }).operation.gather(failedLookup)).toBeNull()
        expect(failedLookup.checklists[0]?.options.some(({ value }) => value === 'chocolatey')).toBe(false)
        const managers = new FakePrompts([['nodejs', 'vite-plus', 'npm', 'bun', 'chocolatey'], base])
        const second = operation({ ChocolateyInstall: choco }, choco)
        await planned(await second.operation.gather(managers)).apply()
        expect(managers.checklists[0]?.options.some(({ value }) => value === 'chocolatey')).toBe(false)
        expect(await realpath(choco)).toBe(choco)
        expect(await realpath(vp)).toBe(vp)
        expect(await realpath(npmLauncher)).toBe(npmLauncher)
        for (const data of [viteNode, npmPackage, bunPackage]) expect((await realpath(data)).startsWith(base)).toBe(true)
        const third = operation({ ChocolateyInstall: choco })
        await planned(await third.operation.gather(new FakePrompts([['nodejs', 'vite-plus', 'npm', 'bun', 'chocolatey'], base]))).apply()
        expect(await realpath(join(choco, 'lib'))).toBe(join(base, 'test', 'chocolatey', 'lib'))
        await planned(await third.operation.gather(new FakePrompts([[]]))).apply()
        for (const data of [standalone, viteNode, npmPackage, bunPackage]) expect(await realpath(data)).toBe(data)
        expect(await realpath(join(choco, 'lib'))).toBe(join(choco, 'lib'))
        for (const { events } of [first, second, third]) expect(events.filter((event) => event.kind === 'failed')).toEqual([])
    },
    transferTimeout
)

/** A process start time in seconds after a fixed minute. */
function at(second: number): string {
    return `2026-11-28T10:00:${String(second).padStart(2, '0')}Z`
}

test('only the toolkit and its launcher wrappers are exempt from the package guards', () => {
    const chain: WindowsProcess[] = [
        { id: 30, name: 'bun.exe', parentId: 20, createdAt: at(4) },
        { id: 20, name: 'vp.exe', parentId: 10, createdAt: at(3) },
        { id: 10, name: 'claude.exe', parentId: 5, createdAt: at(2) },
        { id: 5, name: 'bun.exe', parentId: null, createdAt: at(1) },
        { id: 40, name: 'bun.exe', commandLine: 'bun.exe run src/index.ts', parentId: 10, createdAt: at(5) }
    ]
    expect([...toolkitProcessIds(chain, 30)].toSorted((a, b) => a - b)).toEqual([20, 30])
    expect([...toolkitProcessIds([{ id: 30, name: 'bun.exe' }], 30)]).toEqual([30])
    // The launcher exited and an unrelated `bun install` received its ID after the toolkit started.
    const reused: WindowsProcess[] = [
        { id: 30, name: 'bun.exe', parentId: 20, createdAt: at(4) },
        { id: 20, name: 'bun.exe', commandLine: 'bun install', parentId: 10, createdAt: at(9) }
    ]
    expect([...toolkitProcessIds(reused, 30)]).toEqual([30])
    // Without start times the chain is not trusted.
    expect([
        ...toolkitProcessIds(
            [
                { id: 30, name: 'bun.exe', parentId: 20 },
                { id: 20, name: 'vp.exe', parentId: 10 }
            ],
            30
        )
    ]).toEqual([30])
})

test('another project with the toolkit command line still holds back Bun', async () => {
    await sandbox.file('Users/test/.bun/install/global/package.json', '{"dependencies":{"tool":"1.0.0"}}')
    await sandbox.file('Users/test/.bun/install/global/bun.lock', 'lock')
    await sandbox.directory('Users/test/.bun/install/global/node_modules')
    const { operation, events } = relocation({ processes: [{ id: 4242, name: 'bun.exe', path: 'C:\\Projects\\bun.exe', commandLine: 'bun.exe run src/index.ts', parentId: 1 }] })
    const move = planned(await operation.gather(new FakePrompts([['bun'], join(sandbox.root, 'Software')])))

    expect(move.lines).toContain('Bun is running. Close it before applying, or it will be skipped.')
    await move.apply()
    expect(events).toMatchObject([{ kind: 'skipped', appId: 'bun' }])
    expect((await lstat(join(sandbox.paths.home, '.bun', 'install', 'global'))).isSymbolicLink()).toBe(false)
})

test('a program running from Scoop apps or loading npm global packages holds back the move', async () => {
    const { apps, foo } = await scoopLayout()
    const { globals } = await npmLayout()
    const processes: WindowsProcess[] = [
        { id: 5001, name: 'foo.exe', path: join(foo, 'foo.exe'), commandLine: null },
        { id: 5002, name: 'code.exe', path: 'C:\\Programs\\code.exe', commandLine: `code.exe --require "${join(globals, 'tool', 'index.js')}"` }
    ]
    const { operation, events } = relocation({ processes })
    const move = planned(await operation.gather(new FakePrompts([['scoop', 'npm'], join(sandbox.root, 'Software')])))

    expect(move.lines).toContain('Scoop is running. Close it before applying, or it will be skipped.')
    expect(move.lines).toContain('npm is running. Close it before applying, or it will be skipped.')
    await move.apply()
    expect(events).toMatchObject([
        { kind: 'skipped', appId: 'scoop' },
        { kind: 'skipped', appId: 'npm' }
    ])
    for (const path of [apps, globals]) expect((await lstat(path)).isSymbolicLink()).toBe(false)
})

test('package locations come from the managers’ own configuration', async () => {
    await scoopLayout()
    const customRoot = await sandbox.directory('Users/test/tools/scoop/apps/scoop/1')
    await sandbox.file('Users/test/tools/scoop/apps/scoop/1/bin/scoop.ps1', '# Scoop fixture')
    await symlink(customRoot, join(customRoot, '..', 'current'), 'junction')
    await sandbox.file('Users/test/.config/scoop/config.json', JSON.stringify({ root_path: join(sandbox.paths.home, 'tools', 'scoop') }))
    await sandbox.file('Users/test/.npmrc', 'prefix=${APPDATA}\\custom-npm\n')
    await sandbox.file('Users/test/AppData/Roaming/custom-npm/node_modules/tool/package.json', '{"name":"tool","version":"1.0.0"}')
    await npmLayout()
    const prompts = new FakePrompts([['scoop', 'npm'], join(sandbox.root, 'Software')])

    const move = planned(await relocation().operation.gather(prompts))

    expect(move.lines).toContain(`Move Scoop to another drive`)
    expect(move.lines.some((line) => line.startsWith(`  ${join(sandbox.paths.home, 'tools', 'scoop')} →`))).toBe(true)
    expect(move.lines.some((line) => line.startsWith(`  ${join(sandbox.paths.roamingAppData, 'custom-npm', 'node_modules')} →`))).toBe(true)
    expect(move.lines.some((line) => line.includes(join(sandbox.paths.roamingAppData, 'npm', 'node_modules')))).toBe(false)
})

test('ambiguous package locations are refused with a reason', async () => {
    await npmLayout()
    await sandbox.file('Users/test/.bun/install/global/package.json', '{"dependencies":{"tool":"1.0.0"}}')
    await sandbox.file('Users/test/.bun/install/global/bun.lock', 'lock')
    await sandbox.directory('Users/test/.bun/install/global/node_modules')
    await sandbox.file('Users/test/AppData/Local/Programs/nodejs/node_modules/npm/npmrc', 'prefix=${APPDATA}\\npm\n')
    await sandbox.file('Users/test/scoop/apps/nodejs/current/node_modules/npm/npmrc', `prefix=${join(sandbox.paths.home, 'scoop', 'persist', 'nodejs', 'bin')}\n`)
    const bunfig = join(sandbox.paths.home, '.bunfig.toml')
    await writeFile(bunfig, '[install]\nglobalDir = "C:\\\\Elsewhere\\\\global"\n')
    const prompts = new FakePrompts([[]])

    expect(await relocation({ env: { BUN_INSTALL_GLOBAL_DIR: join(sandbox.paths.home, '.bun', 'install', 'global') } }).operation.gather(prompts)).toBeNull()
    expect(prompts.logs.some((message) => message.startsWith('npm cannot be relocated. npm prefix is set to'))).toBe(true)
    expect(prompts.logs.some((message) => message.startsWith('Bun cannot be relocated. The Bun global directory is set to'))).toBe(true)

    const refusals: [string, string][] = [
        ['[install]\ncache = { dir = "C:\\\\Elsewhere\\\\cache" }\n', `${bunfig} sets install.cache in a form the relocation catalog does not read`],
        // Single backslashes are invalid TOML escapes. Bun is refused, and the catalog still builds.
        ['[install]\nglobalDir = "C:\\Users\\test\\bun-global"\n', `${bunfig} sets install.globalDir in a form the relocation catalog does not read`],
        ['[install]\nregistry = [\n  "https://example.invalid",\n]\n', `${bunfig} has a line the relocation catalog does not read: "https://example.invalid",`]
    ]
    for (const [text, reason] of refusals) {
        await writeFile(bunfig, text)
        const refused = new FakePrompts([[]])
        expect(await relocation().operation.gather(refused)).toBeNull()
        expect(refused.logs).toContain(`Bun cannot be relocated. ${reason}`)
    }
})

test('valid bunfig forms are read, so a stale default cache is not offered', async () => {
    await sandbox.file('Users/test/.bun/install/cache/tool@1.2.3@@@1/package.json', '{"name":"tool","version":"1.2.3"}')
    const bunfig = join(sandbox.paths.home, '.bunfig.toml')
    for (const text of [
        `[install]\ncache . dir = "${join(sandbox.root, 'bun-cache').replaceAll('\\', '\\\\')}"\n`,
        `[[install.scopes]]\nname = "x"\n[install . cache]\ndir = '${join(sandbox.root, 'bun-cache')}'\n`
    ]) {
        await writeFile(bunfig, text)
        const prompts = new FakePrompts([[]])
        expect(await relocation().operation.gather(prompts)).toBeNull()
        expect(prompts.logs.some((message) => message.startsWith('Bun cannot'))).toBe(false)
        expect(prompts.checklists).toHaveLength(0)
    }
    await rm(bunfig)
    const fallback = new FakePrompts([[]])
    expect(await relocation().operation.gather(fallback)).toBeNull()
    expect(fallback.checklists[0]?.options.map(({ value }) => value)).toEqual(['bun'])
})

test('an unreadable Scoop configuration refuses Scoop and npm with the same reason', async () => {
    await scoopLayout()
    await npmLayout()
    const config = await sandbox.file('Users/test/.config/scoop/config.json', '{ "root_path": ')
    const prompts = new FakePrompts([[]])

    expect(await relocation().operation.gather(prompts)).toBeNull()
    expect(prompts.logs).toContain(`Scoop cannot be relocated. Could not parse the Scoop configuration at ${config}`)
    expect(prompts.logs).toContain(`npm cannot be relocated. Could not parse the Scoop configuration at ${config}`)
})

test('distinct catalog names sharing one physical backing directory cannot restore it twice', async () => {
    const backing = await sandbox.directory('Old/test/stores/test/data')
    const outer = await sandbox.directory('Users/test/stores/test')
    const originals = [join(outer, 'data'), join(sandbox.paths.home, 'data')]
    for (const original of originals) await symlink(backing, original, 'junction')
    const catalog = originals.map((path, index) => ({
        id: `app-${index}`,
        label: `App ${index}`,
        processGuardId: 'scoop-relocation',
        paths: [{ path, description: 'data' }]
    }))
    const operation = createRelocationOperation({
        catalog,
        home: sandbox.paths.home,
        journal: createRecoveryJournal(sandbox.paths),
        dryRun: true,
        listProcesses: async () => [],
        volumesDiffer: async () => true,
        driveType: async () => 'fixed',
        report: async () => {}
    })
    const restore = new FakePrompts([[]])
    expect(await operation.gather(restore)).toBeNull()
    expect(restore.checklists).toHaveLength(0)
    expect(restore.logs.filter((message) => message.includes('shares a backing tree'))).toHaveLength(2)
    const move = new FakePrompts([['app-0', 'app-1'], join(sandbox.root, 'New')])
    expect(await operation.gather(move)).toBeNull()
    expect(move.logs.filter((message) => message.includes('shares a backing tree'))).toHaveLength(2)
    for (const original of originals) expect(await realpath(original)).toBe(backing)
})
