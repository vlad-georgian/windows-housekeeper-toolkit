import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

import type { SystemPaths } from './system-paths.ts'

export const projectName = 'windows-housekeeper-toolkit'

export function stateDirectory(paths: SystemPaths): string {
    return join(paths.localAppData, projectName)
}

export async function readState<T>(paths: SystemPaths, name: string, fallback: T): Promise<T> {
    try {
        // The caller owns and validates the schema for this state file.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return JSON.parse(await readFile(join(stateDirectory(paths), name), 'utf8')) as T
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fallback
        throw error
    }
}

export async function writeState(paths: SystemPaths, name: string, value: unknown): Promise<void> {
    const directory = stateDirectory(paths)
    await mkdir(directory, { recursive: true })
    if (!(await lstat(directory)).isDirectory()) {
        throw new Error('The windows-housekeeper-toolkit state directory must be a regular directory.')
    }
    const temporaryPath = join(directory, randomUUID() + '.tmp')
    try {
        await writeFile(temporaryPath, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
        await rename(temporaryPath, join(directory, name))
    } catch (error) {
        await unlink(temporaryPath).catch(() => {})
        throw error
    }
}

export async function withRunLock<T>(paths: SystemPaths, operation: () => Promise<T>): Promise<T> {
    const identity = createHash('sha256').update(stateDirectory(paths).toLowerCase()).digest('hex')
    return withPipeLock(identity, operation)
}

export function withServiceStartupLock<T>(operation: () => Promise<T>): Promise<T> {
    return withPipeLock('app-service-startup', operation)
}

async function withPipeLock<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const pipe = '\\\\.\\pipe\\' + projectName + '-' + identity
    const server = createServer((connection) => connection.destroy())
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(pipe, resolve)
        })
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
            throw new Error('Another windows-housekeeper-toolkit operation is running.', {
                cause: error
            })
        }
        throw error
    }
    try {
        return await operation()
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}
