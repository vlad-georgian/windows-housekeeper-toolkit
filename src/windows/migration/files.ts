import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { copyFile, lstat, open, realpath, statfs, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

import { formatBytes } from '../../core/format.ts'
import { runPowerShell } from '../powershell.ts'

export const logNames = ['logs_2.sqlite', 'logs_2.sqlite-wal', 'logs_2.sqlite-shm', 'logs_2.sqlite-journal', 'codex-tui.log'] as const

export type LogName = (typeof logNames)[number]
export interface LogFile {
    readonly name: LogName
    readonly bytes: number
    readonly sha256: string
}

function normalizePath(path: string): string {
    return resolve(/^[a-z]:$/i.test(path) ? `${path}\\` : path).toLowerCase()
}

export function samePath(first: string, second: string): boolean {
    return normalizePath(first) === normalizePath(second)
}

export function isLocalPath(path: string): boolean {
    if (!/^[a-z]:[\\/]/i.test(path)) return false
    const rest = path.slice(2)
    return !/[:*?"<>|]/u.test(rest) && !Array.from(rest).some((character) => character.charCodeAt(0) < 32)
}

export async function statsIfPresent(path: string): Promise<BigIntStats | null> {
    try {
        return await lstat(path, { bigint: true })
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
    }
}

export async function plainDirectory(path: string): Promise<BigIntStats | null> {
    const root = parse(path).root
    if (!isLocalPath(path)) throw new Error(`Expected a local drive path for ${path}.`)
    if (!samePath(path, root)) await plainDirectory(dirname(path))
    const stats = await statsIfPresent(path)
    if (stats && (!stats.isDirectory() || !samePath(path, await realpath(path)))) {
        throw new Error(`The directory resolves through an alias or link at ${path}.`)
    }
    return stats
}

export async function plainFile(path: string): Promise<BigIntStats | null> {
    await plainDirectory(dirname(path))
    const stats = await statsIfPresent(path)
    if (stats && (!stats.isFile() || stats.nlink !== 1n || !samePath(path, await realpath(path)))) {
        throw new Error(`Expected a single regular file at ${path}.`)
    }
    return stats
}

export async function inspectFile(path: string, name: LogName): Promise<LogFile | null> {
    const before = await plainFile(path)
    if (!before) return null
    const hash = createHash('sha256')
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
    const after = await plainFile(path)
    if (!after || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw new Error(`The file changed while reading ${path}. Close Codex and retry.`)
    }
    return { name, bytes: Number(after.size), sha256: hash.digest('hex') }
}

export function sameFile(actual: LogFile | null, expected: LogFile): boolean {
    return actual?.name === expected.name && actual.bytes === expected.bytes && actual.sha256 === expected.sha256
}

export async function assertPlainLogStreams(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    await runPowerShell(
        `
    foreach ($path in $data.paths) {
      $item = Get-Item -LiteralPath $path -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "A log is a reparse point at $path."
      }
      foreach ($stream in Get-Item -LiteralPath $path -Stream '*' -Force) {
        if ($stream.Stream -ne ':$DATA') { throw "A log has a named stream at $path." }
      }
    }
  `,
        { paths }
    )
}

export async function verifyCapacity(path: string, bytes: number): Promise<void> {
    const volume = await statfs(path, { bigint: true })
    if (BigInt(bytes) > volume.bavail * volume.bsize) {
        throw new Error(`Insufficient free space at ${path}. ${formatBytes(bytes)} is required.`)
    }
}

export async function copyVerifiedLog(source: string, target: string, entry: LogFile, operationId: string, replace: LogFile | null = null): Promise<void> {
    if (samePath(source, target) || !sameFile(await inspectFile(source, entry.name), entry)) {
        throw new Error(`The source changed at ${source}.`)
    }
    const existing = await inspectFile(target, entry.name)
    if (sameFile(existing, entry)) return
    if (existing && (!replace || !sameFile(existing, replace))) {
        throw new Error(`A different file already exists at ${target}.`)
    }

    const staging = join(dirname(target), `.windows-housekeeper-toolkit-${operationId}-${entry.name}.tmp`)
    const staged = await inspectFile(staging, entry.name)
    if (!sameFile(staged, entry)) {
        if (staged) await unlink(staging)
        await copyFile(source, staging, constants.COPYFILE_EXCL)
    }
    if (!sameFile(await inspectFile(staging, entry.name), entry)) {
        throw new Error(`Copy verification failed for ${source}.`)
    }
    const handle = await open(staging, 'r+')
    try {
        await handle.sync()
    } finally {
        await handle.close()
    }
    if (existing) await removeVerifiedLog(target, existing)
    await runPowerShell('[IO.File]::Move($data.source, $data.target)', { source: staging, target })
    if (!sameFile(await inspectFile(target, entry.name), entry)) {
        throw new Error(`Copy verification failed for ${target}.`)
    }
}

export async function removeVerifiedLog(path: string, expected: LogFile): Promise<void> {
    if (!sameFile(await inspectFile(path, expected.name), expected)) {
        throw new Error(`The file changed at ${path}. The recovery copy is available.`)
    }
    await runPowerShell(
        `
    $path = [string]$data.path
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "The log became a reparse point at $path."
    }
    # Share deletion but prevent any application from writing while verifying and deleting.
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Delete)
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
      $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '')
      if ($stream.Length -ne $data.bytes -or $actual -ne $data.sha256) {
        throw "The log changed at $path. The recovery copy is available."
      }
      foreach ($alternate in Get-Item -LiteralPath $path -Stream '*' -Force) {
        if ($alternate.Stream -ne ':$DATA') { throw "A log has a named stream at $path." }
      }
      [IO.File]::Delete($path)
    } finally {
      $hash.Dispose()
      $stream.Dispose()
    }
  `,
        { path, bytes: expected.bytes, sha256: expected.sha256 }
    )
}
