import { afterEach, beforeEach, expect, test } from 'bun:test'
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { cancelled, type PlanSection } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { windowsDriveType } from '../windows/drives.ts'
import { createRelocationCatalog } from './apps/index.ts'
import { createRecoveryJournal } from './journal.ts'
import { differentVolumes } from './layout.ts'
import { createRelocationOperation } from './operation.ts'

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

test('Scoop moves and restores once while two apps retain one persistent directory', async () => {
    const manager = await sandbox.directory('Users/test/scoop/apps/scoop/1')
    await sandbox.file('Users/test/scoop/apps/scoop/1/bin/scoop.ps1', '# Scoop fixture')
    await symlink(manager, join(manager, '..', 'current'), 'junction')
    const shared = await sandbox.directory('Users/test/scoop/persist/shared')
    const configuration = await sandbox.file('Users/test/scoop/persist/shared/settings.txt', 'original')
    const persistentIdentity = (await lstat(shared, { bigint: true })).ino
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
    const env = { NPM_CONFIG_PREFIX: node }
    const apps = join(sandbox.paths.home, 'scoop', 'apps')
    const operation = createRelocationOperation({
        catalog: [
            ...createRelocationCatalog(sandbox.paths, env),
            { id: 'duplicate', label: 'Duplicate app root', processGuardId: 'scoop-relocation', paths: [{ path: apps, description: 'duplicate' }] }
        ],
        home: sandbox.paths.home,
        journal: createRecoveryJournal(sandbox.paths),
        dryRun: false,
        listProcesses: async () => [],
        volumesDiffer: otherVolume ? differentVolumes : async () => true,
        driveType: otherVolume ? windowsDriveType : async () => 'fixed',
        report: async (event) => {
            if (event.kind === 'failed') throw event.error
        }
    })
    const select = new FakePrompts([['scoop', 'npm', 'nodejs', 'duplicate'], base])
    const move = planned(await operation.gather(select))
    expect(select.checklists[0]?.options.map(({ value }) => value)).toEqual(['scoop'])
    expect(move.lines.filter((line) => line.includes('→'))).toHaveLength(1)
    await move.apply()
    expect(await realpath(apps)).toBe(join(base, 'test', 'scoop', 'apps'))
    expect(await readFile(join(node, 'node.exe'), 'utf8')).toBe('fixture executable')
    expect(await readFile(launcher, 'utf8')).toContain(join(node, 'node.exe'))
    await writeFile(join(node, 'data', 'settings.txt'), 'latest')
    expect(await readFile(join(second, 'data', 'settings.txt'), 'utf8')).toBe('latest')

    const clear = new FakePrompts([[]])
    const restore = planned(await operation.gather(clear))
    expect(clear.checklists[0]?.initialValues).toEqual(['scoop'])
    expect(restore.lines.filter((line) => line.includes('→'))).toHaveLength(1)
    await restore.apply()
    expect((await lstat(apps)).isSymbolicLink()).toBe(false)
    expect((await lstat(shared, { bigint: true })).ino).toBe(persistentIdentity)
    expect(await realpath(join(node, 'data'))).toBe(await realpath(join(second, 'data')))
    expect(await readFile(join(outsideConsumer, 'settings.txt'), 'utf8')).toBe('latest')
    expect(await readFile(configuration, 'utf8')).toBe('latest')
})

test('only verified user installations appear and standalone Node can move independently', async () => {
    const standalone = await sandbox.file('Users/test/AppData/Local/Programs/nodejs/node.exe', 'standalone')
    await sandbox.file('Users/test/AppData/Local/Programs/nodejs/node_modules/npm/package.json', '{"name":"npm","version":"11.0.0"}')
    await sandbox.file('Users/test/AppData/Local/nodejs/node.exe', 'unverified')
    const vp = await sandbox.file('Users/test/AppData/Local/vite-plus/bin/vp.exe', 'Vite+')
    const viteNode = await sandbox.file('Users/test/AppData/Local/vite-plus/data/js_runtime/node/26/node.exe', 'managed')
    await sandbox.file('Users/test/AppData/Local/vite-plus/data/1.5/package.json', '{"dependencies":{"vite-plus":"1.5.1"}}')
    await symlink(join(viteNode, '..', '..', '..', '..', '1.5'), join(viteNode, '..', '..', '..', '..', 'current'), 'junction')
    const npmLauncher = await sandbox.file('Users/test/AppData/Roaming/npm/tool.cmd', '@node "%~dp0node_modules/tool/cli.js"')
    const npmPackage = await sandbox.file('Users/test/AppData/Roaming/npm/node_modules/tool/package.json', '{"name":"tool","version":"1.0.0"}')
    await sandbox.directory('Users/test/AppData/Local/npm-cache/_cacache/content-v2')
    await sandbox.directory('Users/test/AppData/Local/npm-cache/_cacache/index-v5')
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

    function operation(env: Record<string, string>, machineChocolatey?: string) {
        return createRelocationOperation({
            catalog: createRelocationCatalog(sandbox.paths, env, async () => machineChocolatey),
            home: sandbox.paths.home,
            journal: createRecoveryJournal(sandbox.paths),
            dryRun: false,
            listProcesses: async () => [
                { id: 1101, name: 'vp.exe', commandLine: '"C:\\Tools\\vp.exe" run start' },
                { id: 1102, name: 'bun.exe', commandLine: '"C:\\Tools\\bun.exe" run src/index.ts' }
            ],
            volumesDiffer: async () => true,
            driveType: async () => 'fixed',
            report: async (event) => {
                if (event.kind === 'failed') throw event.error
            }
        })
    }

    const prompts = new FakePrompts([['nodejs'], base])
    await planned(await operation({ ChocolateyInstall: choco }).gather(prompts)).apply()
    expect(prompts.checklists[0]?.options.map(({ value }) => value).toSorted()).toEqual(['bun', 'chocolatey', 'nodejs', 'npm', 'vite-plus'])
    expect(await realpath(standalone)).toBe(join(base, 'test', 'AppData', 'Local', 'Programs', 'nodejs', 'node.exe'))
    expect(await realpath(viteNode)).toBe(viteNode)
    const machinePrompts = new FakePrompts([['nodejs']])
    expect(await operation({ ChocolateyInstall: machineDefault }).gather(machinePrompts)).toBeNull()
    expect(machinePrompts.checklists[0]?.options.some(({ value }) => value === 'chocolatey')).toBe(false)
    const managers = new FakePrompts([['nodejs', 'vite-plus', 'npm', 'bun', 'chocolatey'], base])
    await planned(await operation({ ChocolateyInstall: choco }, choco).gather(managers)).apply()
    expect(managers.checklists[0]?.options.some(({ value }) => value === 'chocolatey')).toBe(false)
    expect(await realpath(choco)).toBe(choco)
    expect(await realpath(vp)).toBe(vp)
    expect(await realpath(npmLauncher)).toBe(npmLauncher)
    for (const data of [viteNode, npmPackage, bunPackage]) expect((await realpath(data)).startsWith(base)).toBe(true)
    await planned(await operation({ ChocolateyInstall: choco }).gather(new FakePrompts([['nodejs', 'vite-plus', 'npm', 'bun', 'chocolatey'], base]))).apply()
    expect(await realpath(join(choco, 'lib'))).toBe(join(base, 'test', 'chocolatey', 'lib'))
    await planned(await operation({ ChocolateyInstall: choco }).gather(new FakePrompts([[]]))).apply()
    for (const data of [standalone, viteNode, npmPackage, bunPackage]) expect(await realpath(data)).toBe(data)
    expect(await realpath(join(choco, 'lib'))).toBe(join(choco, 'lib'))
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
