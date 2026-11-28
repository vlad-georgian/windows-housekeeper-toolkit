import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../core/filesystem/index.ts'
import { cancelled, type PlanSection } from '../launch/types.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { isolatedPackageSources } from '../test-support/package-sources.ts'
import { windowsDriveType } from '../windows/drives.ts'
import { createRelocationCatalog } from './apps/index.ts'
import { createRecoveryJournal } from './journal.ts'
import { differentVolumes } from './layout.ts'
import { createRelocationOperation } from './operation.ts'

/**
 * A writable directory on a different local volume from the system temporary directory, such
 * as `E:\scratch`. The test creates and removes its own disposable directory inside it.
 */
const otherVolume = process.env.HOUSEKEEPER_TEST_OTHER_VOLUME
// Real cross-volume moves read Windows permissions through PowerShell several times.
const transferTimeout = 120_000

let sandbox: Sandbox
let destinationRoot: string

function planned(result: PlanSection | null | typeof cancelled): PlanSection {
    if (result === null || result === cancelled) throw new Error('Expected a plan section.')
    return result
}

function operation(): ReturnType<typeof createRelocationOperation> {
    return createRelocationOperation({
        home: sandbox.paths.home,
        catalog: createRelocationCatalog(sandbox.paths, isolatedPackageSources),
        journal: createRecoveryJournal(sandbox.paths),
        dryRun: false,
        listProcesses: async () => [],
        volumesDiffer: differentVolumes,
        driveType: windowsDriveType,
        report: async () => {}
    })
}

describe.skipIf(!otherVolume)('relocation across local volumes', () => {
    beforeEach(async () => {
        sandbox = await createSandbox()
        destinationRoot = await mkdtemp(join(otherVolume ?? '', 'housekeeper-test-'))
        await sandbox.file('Users/test/.vscode/extensions/publisher.extension-1.0.0/package.json', '{"version":"1.0.0"}')
    })

    afterEach(async () => {
        await sandbox.dispose()
        await rm(destinationRoot, { recursive: true, force: true })
    })

    test(
        'moves an app to another volume and restores its latest files',
        async () => {
            const original = join(sandbox.paths.home, '.vscode', 'extensions')
            const base = join(destinationRoot, 'Software')
            const destination = join(base, 'test', '.vscode', 'extensions')
            expect(await differentVolumes(sandbox.root, destinationRoot)).toBe(true)

            await planned(await operation().gather(new FakePrompts([['vscode-extensions'], base]))).apply()
            expect((await lstat(original)).isSymbolicLink()).toBe(true)
            expect((await realpath(original)).toLowerCase()).toBe(destination.toLowerCase())

            await writeFile(join(original, 'publisher.extension-1.0.0', 'package.json'), '{"version":"1.0.1"}')
            await planned(await operation().gather(new FakePrompts([[]]))).apply()

            expect((await lstat(original)).isSymbolicLink()).toBe(false)
            expect(await readFile(join(original, 'publisher.extension-1.0.0', 'package.json'), 'utf8')).toBe('{"version":"1.0.1"}')
            expect(await pathExists(destination)).toBe(false)
        },
        transferTimeout
    )

    test('rejects a base on the same volume as the original paths', async () => {
        const prompts = new FakePrompts([['vscode-extensions'], join(sandbox.root, 'Software'), join(destinationRoot, 'Software')])
        planned(await operation().gather(prompts))
        expect(prompts.logs.some((message) => message.includes('another drive'))).toBe(true)
    })

    test(
        'finishes relocating an application to its existing base across volumes',
        async () => {
            const base = join(destinationRoot, 'Software')
            const install = join(sandbox.paths.localAppData, 'GitHubDesktop')
            await sandbox.file('Users/test/AppData/Local/GitHubDesktop/Update.exe', 'updater')
            await planned(await operation().gather(new FakePrompts([['github-desktop'], base]))).apply()

            const data = join(sandbox.paths.roamingAppData, 'GitHub Desktop')
            await sandbox.file('Users/test/AppData/Roaming/GitHub Desktop/window-state.json', '{}')
            await planned(await operation().gather(new FakePrompts([['github-desktop'], base]))).apply()

            expect(await realpath(install)).toBe(join(base, 'test', 'AppData', 'Local', 'GitHubDesktop'))
            expect(await realpath(data)).toBe(join(base, 'test', 'AppData', 'Roaming', 'GitHub Desktop'))
        },
        transferTimeout
    )
})
