import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, link, lstat, readdir, readFile, readlink, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { pathExists } from '../core/filesystem/index.ts'
import { projectName } from '../core/state.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { rejection, rejectionMessage } from '../test-support/rejection.ts'
import { createRecoveryJournal, type RecoveryJournal } from './journal.ts'
import { DestinationConflictError, IncompleteTransferError, moveDirectory, restoreDirectory, UnsupportedTreeError } from './transfer.ts'

let sandbox: Sandbox
let journal: RecoveryJournal
let original: string
let destination: string
let base: string

async function addAppFiles(directory = 'Users/test/AppData/Local/GitHubDesktop'): Promise<void> {
    await sandbox.file(join(directory, 'Update.exe'), 'updater')
    await sandbox.file(join(directory, 'app-3.4.0', 'GitHubDesktop.exe'), 'desktop')
    await sandbox.directory(join(directory, 'packages'))
    const readOnly = await sandbox.file(join(directory, 'app-3.4.0', 'locked.dat'), 'read-only')
    await chmod(readOnly, 0o444)
}

beforeEach(async () => {
    sandbox = await createSandbox()
    journal = createRecoveryJournal(sandbox.paths)
    original = join(sandbox.paths.localAppData, 'GitHubDesktop')
    base = join(sandbox.root, 'E', 'Software')
    destination = join(base, 'test', 'AppData', 'Local', 'GitHubDesktop')
    await addAppFiles()
})

afterEach(async () => {
    // Clear read-only attributes so the sandbox can be disposed.
    for (const path of [join(original, 'app-3.4.0', 'locked.dat'), join(destination, 'app-3.4.0', 'locked.dat')]) {
        await chmod(path, 0o666).catch(() => {})
    }
    await sandbox.dispose()
})

async function expectJunction(path: string, target: string): Promise<void> {
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect((await realpath(path)).toLowerCase()).toBe(target.toLowerCase())
}

async function siblingsOf(path: string): Promise<string[]> {
    // The toolkit keeps its recovery journal in its own state directory beside the app folders.
    return (await readdir(join(path, '..'))).filter((name) => name !== projectName).toSorted()
}

describe('moving a directory', () => {
    test('copies verified contents to the destination and keeps the original path usable through a junction', async () => {
        const result = await moveDirectory({ appId: 'github-desktop', original, destination, base }, { journal })

        expect(result).toEqual({ bytes: 'updater'.length + 'desktop'.length + 'read-only'.length, files: 3 })
        await expectJunction(original, destination)
        expect(await readFile(join(original, 'app-3.4.0', 'GitHubDesktop.exe'), 'utf8')).toBe('desktop')
        expect(await readFile(join(destination, 'Update.exe'), 'utf8')).toBe('updater')
        expect(await pathExists(join(destination, 'packages'))).toBe(true)
        expect((await stat(join(destination, 'app-3.4.0', 'locked.dat'))).mode & 0o200).toBe(0)
        // Source space is reclaimed: only the junction remains beside the other profile folders.
        expect(await siblingsOf(original)).toEqual(['GitHubDesktop', 'Temp'])
        expect(await journal.list()).toEqual([])
    })

    test('refuses an existing destination without changing either side', async () => {
        await sandbox.file('E/Software/test/AppData/Local/GitHubDesktop/other.txt', 'keep me')

        expect(await rejection(moveDirectory({ appId: 'github-desktop', original, destination, base }, { journal }))).toBeInstanceOf(DestinationConflictError)
        expect((await lstat(original)).isDirectory()).toBe(true)
        expect(await readdir(destination)).toEqual(['other.txt'])
    })

    test('preserves a competing destination with identical contents when placement fails', async () => {
        const attempt = moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                async beforePhase(phase) {
                    if (phase === 'swapping') await addAppFiles('E/Software/test/AppData/Local/GitHubDesktop')
                }
            }
        )

        expect(await rejection(attempt)).toBeInstanceOf(DestinationConflictError)
        expect(await readFile(join(destination, 'Update.exe'), 'utf8')).toBe('updater')
        expect((await lstat(original)).isSymbolicLink()).toBe(false)
        expect(await journal.list()).toEqual([])
    })

    test('holds the recovery record if a newly created destination parent becomes a junction before placement', async () => {
        const parent = dirname(destination)
        const savedParent = join(sandbox.root, 'SavedParent')
        const outside = await sandbox.directory('Elsewhere')

        const error = await rejection(
            moveDirectory(
                { appId: 'github-desktop', original, destination, base },
                {
                    journal,
                    async beforePhase(phase) {
                        if (phase !== 'swapping') return
                        await rename(parent, savedParent)
                        await symlink(outside, parent, 'junction')
                    }
                }
            )
        )

        expect(error).toBeInstanceOf(IncompleteTransferError)
        const [record] = await journal.list()
        if (!record) throw new Error('Expected the interrupted move to keep its record.')
        const savedCopy = join(savedParent, basename(record.staging))
        await chmod(join(savedCopy, 'app-3.4.0', 'locked.dat'), 0o666)
        expect(await readFile(join(savedCopy, 'Update.exe'), 'utf8')).toBe('updater')
        expect(await readdir(outside)).toEqual([])
        expect((await lstat(original)).isSymbolicLink()).toBe(false)
    })

    test('keeps the source copy if an identical directory replaces the placed tree', async () => {
        const savedCopy = join(sandbox.root, 'SavedCopy')
        const error = await rejection(
            moveDirectory(
                { appId: 'github-desktop', original, destination, base },
                {
                    journal,
                    async beforePhase(phase) {
                        if (phase !== 'reclaiming') return
                        await rename(destination, savedCopy)
                        await chmod(join(savedCopy, 'app-3.4.0', 'locked.dat'), 0o666)
                        await addAppFiles('E/Software/test/AppData/Local/GitHubDesktop')
                    }
                }
            )
        )

        expect(error).toBeInstanceOf(IncompleteTransferError)
        const [record] = await journal.list()
        if (!record?.aside) throw new Error('Expected the interrupted move to keep its source copy.')
        await chmod(join(record.aside, 'app-3.4.0', 'locked.dat'), 0o666)
        expect(await readFile(join(record.aside, 'Update.exe'), 'utf8')).toBe('updater')
        expect(await readFile(join(destination, 'Update.exe'), 'utf8')).toBe('updater')
    })

    test('undo removes its placed copy when the original changed during copying', async () => {
        const attempt = moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                async beforePhase(phase) {
                    if (phase === 'swapping') await writeFile(join(original, 'Update.exe'), 'changed in use')
                }
            }
        )

        expect(await rejectionMessage(attempt)).toContain('Update.exe differs')
        expect(await readFile(join(original, 'Update.exe'), 'utf8')).toBe('changed in use')
        expect(await pathExists(destination)).toBe(false)
        expect(await journal.list()).toEqual([])
    })

    test('refuses trees that contain links or hard-linked files', async () => {
        await symlink(await sandbox.directory('Elsewhere'), join(original, 'nested'), 'junction')
        expect(await rejection(moveDirectory({ appId: 'github-desktop', original, destination, base }, { journal }))).toBeInstanceOf(UnsupportedTreeError)

        const other = await sandbox.directory('Users/test/AppData/Local/Other')
        await sandbox.file('Users/test/AppData/Local/Other/a.txt')
        await link(join(other, 'a.txt'), join(other, 'b.txt'))
        expect(await rejection(moveDirectory({ appId: 'other', original: other, destination: join(base, 'test', 'Other'), base }, { journal }))).toBeInstanceOf(
            UnsupportedTreeError
        )
        expect(await pathExists(base)).toBe(false)
    })

    test('records recovery information before changing the original path', async () => {
        const seen: unknown[] = []
        await moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: async (phase) => {
                    seen.push({ phase, records: await journal.list() })
                }
            }
        )
        expect(seen).toMatchObject([
            { phase: 'copying', records: [{ appId: 'github-desktop', action: 'move', original, destination, phase: 'copying' }] },
            { phase: 'swapping', records: [{ phase: 'swapping' }] },
            { phase: 'reclaiming', records: [{ phase: 'reclaiming' }] }
        ])
    })

    test('keeps the verified copy in staging until the swapping phase is recorded', async () => {
        const seen: unknown[] = []
        await moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: async (phase) => {
                    if (phase !== 'swapping') return
                    const [record] = await journal.list()
                    seen.push({ staging: await pathExists(record?.staging ?? ''), destination: await pathExists(destination), createdParent: record?.createdParent })
                }
            }
        )
        expect(seen).toEqual([{ staging: true, destination: false, createdParent: join(sandbox.root, 'E') }])
    })

    test('an undone move removes only the empty folders it created under the base', async () => {
        await sandbox.directory('E/Software/test/AppData')
        const attempt = moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: (phase) => {
                    if (phase === 'swapping') throw new Error('simulated interruption')
                }
            }
        )
        expect(await rejectionMessage(attempt)).toContain('simulated interruption')

        expect(await pathExists(join(base, 'test', 'AppData', 'Local'))).toBe(false)
        expect(await pathExists(join(base, 'test', 'AppData'))).toBe(true)
    })

    test('undoes a move interrupted before the junction is verified', async () => {
        const failure = new Error('simulated interruption')
        const attempt = moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: (phase) => {
                    if (phase === 'swapping') throw failure
                }
            }
        )
        expect(await rejectionMessage(attempt)).toContain('simulated interruption')

        expect((await lstat(original)).isDirectory()).toBe(true)
        expect(await readFile(join(original, 'Update.exe'), 'utf8')).toBe('updater')
        expect(await pathExists(destination)).toBe(false)
        expect(await siblingsOf(original)).toEqual(['GitHubDesktop', 'Temp'])
        expect(await journal.list()).toEqual([])
    })

    test('retains recovery information when the source copy cannot be reclaimed', async () => {
        const attempt = moveDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: (phase) => {
                    if (phase === 'reclaiming') throw new Error('simulated interruption')
                }
            }
        )
        expect(await rejection(attempt)).toBeInstanceOf(IncompleteTransferError)

        await expectJunction(original, destination)
        const [record] = await journal.list()
        expect(record).toMatchObject({ appId: 'github-desktop', action: 'move', original, destination, phase: 'reclaiming' })
        expect(record?.aside && (await pathExists(join(record.aside, 'Update.exe')))).toBe(true)
    })
})

describe('restoring a directory', () => {
    test('keeps a pre-existing empty parent under the relocation base', async () => {
        const parent = await sandbox.directory('E/Software/test/AppData/Local')
        const transfer = { appId: 'github-desktop', original, destination, base }
        await moveDirectory(transfer, { journal })

        await restoreDirectory(transfer, { journal })

        expect(await pathExists(destination)).toBe(false)
        expect(await readdir(parent)).toEqual([])
    })

    test('brings the latest contents back and releases the destination after verification', async () => {
        await moveDirectory({ appId: 'github-desktop', original, destination, base }, { journal })
        await writeFile(join(original, 'app-3.4.0', 'settings.json'), 'latest')

        const result = await restoreDirectory({ appId: 'github-desktop', original, destination, base }, { journal })

        expect(result.files).toBe(4)
        const stats = await lstat(original)
        expect(stats.isSymbolicLink()).toBe(false)
        expect(stats.isDirectory()).toBe(true)
        expect(await readFile(join(original, 'app-3.4.0', 'settings.json'), 'utf8')).toBe('latest')
        expect((await stat(join(original, 'app-3.4.0', 'locked.dat'))).mode & 0o200).toBe(0)
        expect(await pathExists(destination)).toBe(false)
        expect(await pathExists(base)).toBe(true)
        expect(await siblingsOf(original)).toEqual(['GitHubDesktop', 'Temp'])
        expect(await journal.list()).toEqual([])
    })

    test('refuses an original path that does not link to the destination', async () => {
        expect(await rejectionMessage(restoreDirectory({ appId: 'github-desktop', original, destination, base }, { journal }))).toContain('does not link to')
        expect((await lstat(original)).isDirectory()).toBe(true)
    })

    test('keeps the junction and destination when a restore is interrupted before the swap', async () => {
        await moveDirectory({ appId: 'github-desktop', original, destination, base }, { journal })
        const attempt = restoreDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: (phase) => {
                    if (phase === 'swapping') throw new Error('simulated interruption')
                }
            }
        )
        expect(await rejectionMessage(attempt)).toContain('simulated interruption')

        await expectJunction(original, destination)
        expect(await readlink(original)).toBeTruthy()
        expect(await siblingsOf(original)).toEqual(['GitHubDesktop', 'Temp'])
        expect(await journal.list()).toEqual([])
    })

    test('retains recovery information when the destination cannot be released', async () => {
        await moveDirectory({ appId: 'github-desktop', original, destination, base }, { journal })
        const attempt = restoreDirectory(
            { appId: 'github-desktop', original, destination, base },
            {
                journal,
                beforePhase: (phase) => {
                    if (phase === 'releasing') throw new Error('simulated interruption')
                }
            }
        )
        expect(await rejection(attempt)).toBeInstanceOf(IncompleteTransferError)

        expect((await lstat(original)).isDirectory()).toBe(true)
        expect(await pathExists(join(destination, 'Update.exe'))).toBe(true)
        expect(await journal.list()).toMatchObject([{ action: 'restore', original, destination, phase: 'releasing' }])
    })
})
