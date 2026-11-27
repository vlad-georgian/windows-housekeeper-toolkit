import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../core/filesystem/index.ts'
import { cancelled, type PlanSection } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import type { WindowsProcess } from '../windows/processes.ts'
import { createRelocationCatalog } from './apps/index.ts'
import { createRecoveryJournal, type RecoveryJournal } from './journal.ts'
import type { VolumeComparison } from './layout.ts'
import { createRelocationOperation, type RelocationEvent } from './operation.ts'
import { restoreDirectory } from './transfer.ts'

let sandbox: Sandbox
let journal: RecoveryJournal
let base: string
let processes: WindowsProcess[]
let events: RelocationEvent[]

const desktopInstall = (): string => join(sandbox.paths.localAppData, 'GitHubDesktop')
const desktopData = (): string => join(sandbox.paths.roamingAppData, 'GitHub Desktop')
const extensions = (): string => join(sandbox.paths.home, '.vscode', 'extensions')
const mirrored = (original: string): string => join(base, 'test', original.slice(sandbox.paths.home.length + 1))

function operation(dryRun = false, volumesDiffer: VolumeComparison = async () => true): ReturnType<typeof createRelocationOperation> {
    return createRelocationOperation({
        home: sandbox.paths.home,
        catalog: createRelocationCatalog(sandbox.paths),
        journal,
        dryRun,
        listProcesses: async () => processes,
        // The sandbox lives on one volume; tests treat the base as another drive.
        volumesDiffer,
        driveType: async () => 'fixed',
        report: async (event) => {
            events.push(event)
        }
    })
}

function planned(result: PlanSection | null | typeof cancelled): PlanSection {
    if (result === null || result === cancelled) throw new Error('Expected a plan section.')
    return result
}

async function isLinkTo(path: string, target: string): Promise<boolean> {
    return (await lstat(path)).isSymbolicLink() && (await realpath(path)).toLowerCase() === target.toLowerCase()
}

async function moveApps(ids: string[]): Promise<void> {
    await planned(await operation().gather(new FakePrompts([ids, base]))).apply()
}

beforeEach(async () => {
    sandbox = await createSandbox()
    journal = createRecoveryJournal(sandbox.paths)
    base = join(sandbox.root, 'E', 'Software')
    processes = [{ id: 4, name: 'explorer.exe', path: null, commandLine: null }]
    events = []
    await sandbox.file('Users/test/AppData/Local/GitHubDesktop/app-3.4.0/GitHubDesktop.exe', 'desktop')
    await sandbox.file('Users/test/AppData/Roaming/GitHub Desktop/window-state.json', '{}')
    await sandbox.file('Users/test/.vscode/extensions/publisher.extension-1.0.0/package.json', '{}')
})

afterEach(() => sandbox.dispose())

describe('moving apps to another drive', () => {
    test('offers installed apps unchecked, then moves newly selected apps under the base', async () => {
        const prompts = new FakePrompts([['github-desktop'], base])
        const section = planned(await operation().gather(prompts))

        expect(prompts.checklists[0]?.options.map((option) => option.value)).toEqual(['github-desktop', 'vscode-extensions'])
        expect(prompts.checklists[0]?.initialValues).toEqual([])
        expect(section.lines).toEqual([
            'Move GitHub Desktop to another drive',
            `  ${desktopInstall()} → ${mirrored(desktopInstall())} (7 B)`,
            `  ${desktopData()} → ${mirrored(desktopData())} (2 B)`
        ])
        expect(await pathExists(base)).toBe(false)

        await section.apply()

        expect(await isLinkTo(desktopInstall(), mirrored(desktopInstall()))).toBe(true)
        expect(await isLinkTo(desktopData(), mirrored(desktopData()))).toBe(true)
        expect(await readFile(join(desktopInstall(), 'app-3.4.0', 'GitHubDesktop.exe'), 'utf8')).toBe('desktop')
        expect((await lstat(extensions())).isSymbolicLink()).toBe(false)
        expect(events).toMatchObject([
            { kind: 'moved', appId: 'github-desktop', original: desktopInstall() },
            { kind: 'moved', appId: 'github-desktop', original: desktopData() }
        ])
    })

    test('starts an app checked only when all its paths link to the mirrored destinations', async () => {
        await moveApps(['github-desktop', 'vscode-extensions'])
        const prompts = new FakePrompts([['github-desktop', 'vscode-extensions']])

        expect(await operation().gather(prompts)).toBeNull()
        expect(prompts.checklists[0]?.initialValues).toEqual(['github-desktop', 'vscode-extensions'])
        expect(prompts.checklists[0]?.options[0]?.hint).toContain(base)
        expect(prompts.texts).toEqual([])
    })

    test('asks again until the base is an absolute directory on another drive', async () => {
        const prompts = new FakePrompts([['vscode-extensions'], 'Software', join(sandbox.paths.home, 'Moved'), base])
        planned(await operation().gather(prompts))

        expect(prompts.texts).toHaveLength(3)
        expect(prompts.logs.some((message) => message.includes('absolute'))).toBe(true)
        expect(prompts.logs.some((message) => message.includes('outside the Windows profile'))).toBe(true)
    })

    test('reports a destination conflict before changing any data', async () => {
        await sandbox.file('E/Software/test/AppData/Roaming/GitHub Desktop/existing.json', 'keep')
        const prompts = new FakePrompts([['github-desktop'], base])

        expect(await operation().gather(prompts)).toBeNull()
        expect(prompts.logs.some((message) => message.includes('already exists'))).toBe(true)
        expect((await lstat(desktopInstall())).isSymbolicLink()).toBe(false)
        expect(await readFile(join(mirrored(desktopData()), 'existing.json'), 'utf8')).toBe('keep')
    })

    test('reports a partial move when a later path fails and offers recovery in the checklist', async () => {
        const prompts = new FakePrompts([['github-desktop'], base])
        const section = planned(await operation().gather(prompts))
        const conflict = await sandbox.file('E/Software/test/AppData/Roaming/GitHub Desktop/existing.json', 'keep')

        await section.apply()

        expect(await isLinkTo(desktopInstall(), mirrored(desktopInstall()))).toBe(true)
        expect((await lstat(desktopData())).isSymbolicLink()).toBe(false)
        expect(prompts.logs).toContain(`Completed move for ${desktopInstall()}.`)
        expect(prompts.logs).toContain(`Transfer stopped at ${desktopData()}.`)
        expect(events).toMatchObject([
            { kind: 'moved', original: desktopInstall() },
            { kind: 'failed', original: desktopData(), completed: [desktopInstall()] }
        ])

        await planned(await operation().gather(new FakePrompts([[]]))).apply()
        expect((await lstat(desktopInstall())).isSymbolicLink()).toBe(false)
        expect(await readFile(conflict, 'utf8')).toBe('keep')
        expect(await journal.list()).toEqual([])
    })

    test('reports an app in use in the plan and skips it if it is still running', async () => {
        processes.push({ id: 1234, name: 'GitHubDesktop.exe', path: null, commandLine: null })
        const section = planned(await operation().gather(new FakePrompts([['github-desktop'], base])))

        expect(section.lines.some((line) => line.includes('is running'))).toBe(true)
        await section.apply()
        expect((await lstat(desktopInstall())).isSymbolicLink()).toBe(false)
        expect(events).toMatchObject([{ kind: 'skipped', appId: 'github-desktop' }])
    })

    test('finishes relocating a partially migrated application to its existing base', async () => {
        await moveApps(['github-desktop'])
        await restoreDirectory({ appId: 'github-desktop', original: desktopData(), destination: mirrored(desktopData()), base }, { journal })

        const prompts = new FakePrompts([['github-desktop'], base])
        const followsLinks = async (_base: string, original: string): Promise<boolean> => !(await realpath(original)).startsWith(base)
        const section = planned(await operation(false, followsLinks).gather(prompts))
        expect(prompts.checklists[0]?.initialValues).toEqual([])
        expect(prompts.texts[0]?.initialValue).toBe(base)
        expect(section.lines).toEqual([
            'Move GitHub Desktop to another drive',
            `  ${desktopInstall()} already links to ${mirrored(desktopInstall())}`,
            `  ${desktopData()} → ${mirrored(desktopData())} (2 B)`
        ])
        await section.apply()

        expect(await isLinkTo(desktopInstall(), mirrored(desktopInstall()))).toBe(true)
        expect(await isLinkTo(desktopData(), mirrored(desktopData()))).toBe(true)
    })

    test('refuses to move an app whose path links somewhere else', async () => {
        const elsewhere = await sandbox.directory('Elsewhere/extensions')
        await sandbox.file('Elsewhere/extensions/other/package.json', '{}')
        const original = extensions()
        await rm(original, { recursive: true })
        await symlink(elsewhere, original, 'junction')
        const prompts = new FakePrompts([['vscode-extensions'], base])

        expect(await operation().gather(prompts)).toBeNull()
        expect(prompts.checklists[0]?.initialValues).toEqual([])
        expect(prompts.logs.some((message) => message.includes('links to'))).toBe(true)
        expect(await isLinkTo(original, elsewhere)).toBe(true)
    })

    test('a dry run previews the move without changing anything', async () => {
        const section = planned(await operation(true).gather(new FakePrompts([['github-desktop'], base])))
        await section.apply()

        expect((await lstat(desktopInstall())).isSymbolicLink()).toBe(false)
        expect(await pathExists(base)).toBe(false)
        expect(events).toMatchObject([{ kind: 'previewed', appId: 'github-desktop' }])
    })

    test('cancelling the checklist or the base prompt leaves the plan unapplied', async () => {
        expect(await operation().gather(new FakePrompts([null]))).toBe(cancelled)
        expect(await operation().gather(new FakePrompts([['github-desktop'], null]))).toBe(cancelled)
        expect(await pathExists(base)).toBe(false)
    })

    test('offers nothing when no supported app is installed', async () => {
        await rm(desktopInstall(), { recursive: true })
        await rm(desktopData(), { recursive: true })
        await rm(extensions(), { recursive: true })
        const prompts = new FakePrompts([])

        expect(await operation().gather(prompts)).toBeNull()
        expect(prompts.checklists).toEqual([])
    })
})

describe('restoring migrated applications', () => {
    test('leaving a partially restored application clear restores its remaining linked path', async () => {
        await moveApps(['github-desktop'])
        await restoreDirectory({ appId: 'github-desktop', original: desktopInstall(), destination: mirrored(desktopInstall()), base }, { journal })
        await writeFile(join(desktopData(), 'window-state.json'), 'latest')
        events = []

        const prompts = new FakePrompts([[]])
        const section = planned(await operation().gather(prompts))
        expect(prompts.checklists[0]?.initialValues).toEqual([])
        expect(prompts.checklists[0]?.options[0]?.hint).toContain('Partially migrated')
        expect(section.lines).toEqual(['Restore GitHub Desktop to its original paths', `  ${mirrored(desktopData())} → ${desktopData()} (6 B)`])
        await section.apply()

        expect((await lstat(desktopData())).isSymbolicLink()).toBe(false)
        expect(await readFile(join(desktopData(), 'window-state.json'), 'utf8')).toBe('latest')
        expect(events).toMatchObject([{ kind: 'restored', original: desktopData() }])
        expect(await operation().gather(new FakePrompts([[]]))).toBeNull()
    })

    test('clearing a migrated application restores its latest contents and releases the destination', async () => {
        await moveApps(['github-desktop'])
        await writeFile(join(desktopData(), 'window-state.json'), '{"latest":true}')
        events = []

        const prompts = new FakePrompts([[]])
        const section = planned(await operation().gather(prompts))
        expect(prompts.texts).toEqual([])
        expect(section.lines).toEqual([
            'Restore GitHub Desktop to its original paths',
            `  ${mirrored(desktopInstall())} → ${desktopInstall()} (7 B)`,
            `  ${mirrored(desktopData())} → ${desktopData()} (15 B)`
        ])
        await section.apply()

        expect((await lstat(desktopData())).isSymbolicLink()).toBe(false)
        expect(await readFile(join(desktopData(), 'window-state.json'), 'utf8')).toBe('{"latest":true}')
        expect(await pathExists(mirrored(desktopInstall()))).toBe(false)
        expect(await pathExists(mirrored(desktopData()))).toBe(false)
        expect(events).toMatchObject([{ kind: 'restored' }, { kind: 'restored' }])
    })

    test('reports a migrated application that cannot be restored without changing it', async () => {
        await moveApps(['vscode-extensions'])
        await symlink(await sandbox.directory('Elsewhere'), join(extensions(), 'linked'), 'junction')
        const prompts = new FakePrompts([[]])

        expect(await operation().gather(prompts)).toBeNull()
        expect(prompts.logs.some((message) => message.includes('cannot be restored') && message.includes('is a link'))).toBe(true)
        expect(await isLinkTo(extensions(), mirrored(extensions()))).toBe(true)
    })

    test('holds back an app with an interrupted transfer and points to its recovery information', async () => {
        await journal.save({
            id: '00000000-0000-4000-8000-000000000000',
            appId: 'github-desktop',
            action: 'move',
            original: desktopInstall(),
            destination: mirrored(desktopInstall()),
            staging: `${mirrored(desktopInstall())}.partial`,
            aside: `${desktopInstall()}.moved`,
            createdParent: null,
            phase: 'swapping',
            startedAt: new Date(0).toISOString()
        })
        const prompts = new FakePrompts([[]])

        expect(await operation().gather(prompts)).toBeNull()
        expect(prompts.checklists[0]?.options.map((option) => option.value)).toEqual(['vscode-extensions'])
        expect(prompts.logs.some((message) => message.includes(journal.location))).toBe(true)
    })
})
