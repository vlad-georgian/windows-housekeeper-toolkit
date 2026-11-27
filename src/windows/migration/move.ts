import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { formatBytes } from '../../core/format.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import { updateCodexLogSetting, verifyCodexConfiguration } from './codex-config.ts'
import { assertCodexClosed } from './codex-environment.ts'
import { copyVerifiedLog, isLocalPath, plainDirectory, plainFile, removeVerifiedLog, samePath, verifyCapacity } from './files.ts'
import { saveMigration, savePhase, type Migration } from './journal.ts'
import { bytes, checkLocations, identifyDirectory, snapshot, sourcePath, verifySnapshot } from './snapshot.ts'

export async function startMove(paths: SystemPaths, operation: Migration | null, destination: string): Promise<void> {
    if (operation && operation.phase !== 'rolled-back') {
        throw new Error('A Codex migration already exists. Use migration resume codex-logs or migration rollback codex-logs.')
    }
    if (!isLocalPath(destination)) throw new Error('Choose an absolute destination on a Windows drive.')
    const target = resolve(destination)
    const home = join(paths.home, '.codex')
    const parent = dirname(target)
    if (samePath(target, parent)) throw new Error('Choose a directory below the destination drive root.')
    const [source, volume] = await Promise.all([plainDirectory(home), plainDirectory(parent)])
    if (!source || !volume) throw new Error('The Codex directory and the destination parent must exist.')
    if (source.dev === volume.dev) throw new Error('Choose a different volume from the original Codex directory.')
    const destinationStats = await plainDirectory(target)
    if (destinationStats && (destinationStats.dev !== volume.dev || (await readdir(target)).length !== 0)) {
        throw new Error(`Choose a new or empty destination directory at ${target}.`)
    }
    await assertCodexClosed()
    await verifyCodexConfiguration(paths, home, null)
    const original = await snapshot(home, false)
    if (original.length === 0) throw new Error('There are no verified Codex diagnostic files to move.')
    await verifyCapacity(parent, bytes(original))
    const next: Migration = {
        id: randomUUID(),
        home,
        homeIdentity: `${source.dev}/${source.ino}`,
        destination: target,
        destinationIdentity: null,
        priorLogDir: null,
        phase: 'copying',
        original,
        latest: null,
        rollbackSource: []
    }
    await saveMigration(paths, next)
    return finishMove(paths, next)
}

export async function finishMove(paths: SystemPaths, operation: Migration): Promise<void> {
    await assertCodexClosed()
    await checkLocations(operation)
    const config = join(operation.home, 'config.toml')
    if (operation.phase === 'copying') {
        await verifyCodexConfiguration(paths, operation.home, operation.priorLogDir)
        await verifySnapshot(operation.home, false, operation.original)
        if (!operation.destinationIdentity) {
            if (!(await plainDirectory(operation.destination))) await mkdir(operation.destination)
            if ((await readdir(operation.destination)).length !== 0) {
                throw new Error(`The migration destination must be empty at ${operation.destination}.`)
            }
            const identity = await identifyDirectory(operation.destination)
            if (!identity) throw new Error(`The destination disappeared at ${operation.destination}.`)
            operation = { ...operation, destinationIdentity: identity }
            await saveMigration(paths, operation)
        }
        const pending = []
        for (const file of operation.original) {
            if (!(await plainFile(join(operation.destination, file.name)))) pending.push(file)
        }
        await verifyCapacity(operation.destination, bytes(pending))
        for (const file of operation.original) {
            await copyVerifiedLog(sourcePath(operation.home, file.name), join(operation.destination, file.name), file, operation.id)
        }
        await verifySnapshot(operation.destination, true, operation.original)
        await verifySnapshot(operation.home, false, operation.original)
        operation = await savePhase(paths, operation, 'redirecting')
    }

    if (operation.phase === 'redirecting') {
        await assertCodexClosed()
        await checkLocations(operation)
        await verifySnapshot(operation.home, false, operation.original)
        await verifySnapshot(operation.destination, true, operation.original)
        await updateCodexLogSetting(config, operation.destination, operation.id, false)
        await verifyCodexConfiguration(paths, operation.home, operation.destination, operation.id)
        operation = await savePhase(paths, operation, 'reclaiming')
    }

    await assertCodexClosed()
    await checkLocations(operation)
    await verifyCodexConfiguration(paths, operation.home, operation.destination, operation.id)
    await verifySnapshot(operation.destination, true, operation.original)
    const remaining = await verifySnapshot(operation.home, false, operation.original, true)
    await assertCodexClosed()
    // Preserve the SQLite main file until its sidecars have been reclaimed.
    for (const file of remaining.toReversed()) {
        await removeVerifiedLog(sourcePath(operation.home, file.name), file)
    }
    await verifySnapshot(operation.home, false, [], true)
    await savePhase(paths, operation, 'moved')
    console.log(`Moved Codex diagnostics to ${operation.destination} and reclaimed ${formatBytes(bytes(operation.original))} at ${operation.home}.`)
}
