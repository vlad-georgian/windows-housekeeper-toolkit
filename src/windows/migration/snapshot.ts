import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { assertPlainLogStreams, inspectFile, logNames, plainDirectory, sameFile, type LogFile, type LogName } from './files.ts'
import type { Migration } from './journal.ts'

export function sourcePath(home: string, name: LogName): string {
    return name === 'codex-tui.log' ? join(home, 'log', name) : join(home, name)
}

export function bytes(files: readonly LogFile[]): number {
    return files.reduce((total, file) => total + file.bytes, 0)
}

export async function snapshot(home: string, migrated: boolean): Promise<LogFile[]> {
    if (!(await plainDirectory(home))) return []
    for (const name of await readdir(home)) {
        if (/^logs_\d+\.sqlite(?:$|-)/iu.test(name) && !logNames.some((known) => known === name)) {
            throw new Error(`The diagnostic database format is unverified at ${join(home, name)}.`)
        }
    }

    const files: LogFile[] = []
    const locations: string[] = []
    for (const name of logNames) {
        const path = migrated ? join(home, name) : sourcePath(home, name)
        const entry = await inspectFile(path, name)
        if (entry) {
            files.push(entry)
            locations.push(path)
        }
    }
    await assertPlainLogStreams(locations)
    const database = files.find((file) => file.name === 'logs_2.sqlite')
    if (!database && files.some((file) => file.name.startsWith('logs_2.sqlite-'))) {
        throw new Error(`The diagnostic log database is missing at ${home}.`)
    }
    if (database) {
        const path = join(home, database.name)
        const handle = await open(path, 'r')
        try {
            const header = Buffer.alloc(16)
            await handle.read(header, 0, header.length, 0)
            if (header.toString() !== 'SQLite format 3\0') throw new Error(`Invalid SQLite header at ${path}.`)
        } finally {
            await handle.close()
        }
    }
    return files
}

export async function verifySnapshot(home: string, migrated: boolean, expected: readonly LogFile[], allowMissing = false): Promise<LogFile[]> {
    // During reclamation a partially removed SQLite bundle is expected. Verify its remaining files individually.
    const actual = allowMissing ? [] : await snapshot(home, migrated)
    if (allowMissing) {
        for (const name of logNames) {
            const entry = await inspectFile(sourcePath(home, name), name)
            if (entry) actual.push(entry)
        }
    }
    if ((!allowMissing && actual.length !== expected.length) || actual.some((entry) => !expected.some((file) => sameFile(entry, file)))) {
        throw new Error(`The diagnostic files changed at ${home}. The journal and recovery copy are available.`)
    }
    return actual
}

export async function identifyDirectory(path: string): Promise<string | null> {
    const stats = await plainDirectory(path)
    return stats ? `${stats.dev}/${stats.ino}` : null
}

export async function checkLocations(operation: Migration): Promise<void> {
    if ((await identifyDirectory(operation.home)) !== operation.homeIdentity) {
        throw new Error(`The original Codex directory changed at ${operation.home}.`)
    }
    if (operation.destinationIdentity && (await identifyDirectory(operation.destination)) !== operation.destinationIdentity) {
        throw new Error(`The migration destination changed or is unavailable at ${operation.destination}.`)
    }
}
