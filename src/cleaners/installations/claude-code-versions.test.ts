import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import type { CommandResult, CommandRunner } from '../../core/types.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import type { WindowsProcess } from '../../windows/processes.ts'
import { ClaudeCodeInstallationCleaner } from './claude-code-cleaner.ts'

let sandbox: Sandbox
const versions = join('Users', 'test', '.local', 'share', 'claude', 'versions')
const launcher = (): string => join(sandbox.paths.home, '.local', 'bin', 'claude.exe')
// Windows reports no path for system processes. They cannot be running from a user install.
const quietProcesses = async (): Promise<WindowsProcess[]> => [{ id: 4, name: 'System', path: null, commandLine: null }]
const running = async (): Promise<WindowsProcess[]> => [{ id: 9, name: 'claude.exe', path: join(sandbox.root, versions, '2.1.325'), commandLine: null }]
// Windows hides the path of an elevated process from an unelevated tool.
const elevated = async (): Promise<WindowsProcess[]> => [{ id: 11, name: 'claude.exe', path: null, commandLine: null }]
const noop = { onRemoved: async (): Promise<void> => {} }

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

function runner(nativeVersion: string | null, pathVersion = '1.0.0'): CommandRunner & { calls: string[][] } {
    const calls: string[][] = []
    const run = async (command: readonly string[]): Promise<CommandResult> => {
        calls.push([...command])
        const version = command[0] === launcher() ? nativeVersion : pathVersion
        return version === null ? { exitCode: 1, stdout: '', stderr: 'failed' } : { exitCode: 0, stdout: `${version} (Claude Code)\n`, stderr: '' }
    }
    return Object.assign(run, { calls })
}

async function addVersions(...names: string[]): Promise<void> {
    for (const name of names) await sandbox.file(join(versions, name), `binary ${name}`)
    await sandbox.file(join('Users', 'test', '.local', 'bin', 'claude.exe'), 'launcher')
}

const cleaner = (run: CommandRunner, listProcesses = quietProcesses): ClaudeCodeInstallationCleaner => new ClaudeCodeInstallationCleaner(sandbox.paths, run, listProcesses)
const names = async (instance: ClaudeCodeInstallationCleaner): Promise<string[]> => (await instance.detect()).map((candidate) => candidate.displayName).toSorted()

describe('native Claude Code versions', () => {
    test('offers versions older than the active native version and preserves the active and newer ones', async () => {
        await addVersions('2.1.324', '2.1.325', '2.1.326', '2.1.327', '2.1.328')

        expect(await names(cleaner(runner('2.1.327')))).toEqual(['Claude Code 2.1.324', 'Claude Code 2.1.325', 'Claude Code 2.1.326'])
    })

    test('identifies the active version from the native launcher even when another launcher is first on PATH', async () => {
        await addVersions('2.1.325', '2.1.326', '2.1.327')
        // A PATH-first launcher such as an npm install reports a different, older version.
        const run = runner('2.1.327', '2.1.325')

        expect(await names(cleaner(run))).toEqual(['Claude Code 2.1.325', 'Claude Code 2.1.326'])
        expect(run.calls).toEqual([[launcher(), '--version']])
    })

    test('offers nothing when the native version cannot be verified', async () => {
        await addVersions('2.1.325', '2.1.326')
        expect(await names(cleaner(runner(null)))).toEqual([])
        expect(await names(cleaner(runner('9.9.9')))).toEqual([])
    })

    test('offers nothing without a native launcher', async () => {
        await sandbox.file(join(versions, '2.1.325'))
        await sandbox.file(join(versions, '2.1.326'))
        expect(await names(cleaner(runner('2.1.326')))).toEqual([])
    })

    test('skips versions that are running', async () => {
        await addVersions('2.1.325', '2.1.326', '2.1.327')

        expect(await names(cleaner(runner('2.1.327'), running))).toEqual(['Claude Code 2.1.326'])
    })

    test('offers nothing when the native launcher is a link rather than the installer copy', async () => {
        await addVersions('2.1.325', '2.1.326')
        await rm(launcher())
        await symlink(join(sandbox.root, versions, '2.1.326'), launcher())

        expect(await names(cleaner(runner('2.1.326')))).toEqual([])
    })

    test('offers nothing when a Claude process has no readable path, such as an elevated session', async () => {
        await addVersions('2.1.325', '2.1.326')

        expect(await names(cleaner(runner('2.1.326'), elevated))).toEqual([])
    })

    test('removes a superseded version and revalidates the active version first', async () => {
        await addVersions('2.1.325', '2.1.326')
        const [candidate] = await cleaner(runner('2.1.326')).detect()
        if (!candidate) throw new Error('Expected a candidate.')

        // The launcher is updated to the version being removed after detection.
        expect(await rejection(cleaner(runner('2.1.325')).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, versions, '2.1.325'))).toBe(true)

        await cleaner(runner('2.1.326')).remove(candidate, noop)
        expect(await pathExists(join(sandbox.root, versions, '2.1.325'))).toBe(false)
        expect(await pathExists(join(sandbox.root, versions, '2.1.326'))).toBe(true)
    })

    test('refuses removal when a Claude process path cannot be read', async () => {
        await addVersions('2.1.325', '2.1.326')
        const [candidate] = await cleaner(runner('2.1.326')).detect()
        if (!candidate) throw new Error('Expected a candidate.')

        expect(await rejection(cleaner(runner('2.1.326'), elevated).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, versions, '2.1.325'))).toBe(true)
    })

    test('refuses removal when the version started running', async () => {
        await addVersions('2.1.325', '2.1.326')
        const [candidate] = await cleaner(runner('2.1.326')).detect()
        if (!candidate) throw new Error('Expected a candidate.')

        expect(await rejection(cleaner(runner('2.1.326'), running).remove(candidate, noop))).toBeInstanceOf(Error)
        expect(await pathExists(join(sandbox.root, versions, '2.1.325'))).toBe(true)
    })
})
