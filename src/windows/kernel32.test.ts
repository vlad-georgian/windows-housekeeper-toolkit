import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, readFile, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { entryIdentity, hasErrorCode, pathExists } from '../core/filesystem/paths.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { rejection } from '../test-support/rejection.ts'
import { moveExclusive, type ReparsePointKind, reparsePointKind } from './kernel32.ts'

let sandbox: Sandbox
beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(async () => sandbox.dispose())

describe('native file operations', () => {
    test('refuses to replace an existing file and leaves both names intact', async () => {
        const from = await sandbox.file('aside', 'previous')
        const to = await sandbox.file('original', 'written by the app')
        const error = await rejection(moveExclusive(from, to))
        expect(hasErrorCode(error, 'EEXIST')).toBe(true)
        expect(await readFile(to, 'utf8')).toBe('written by the app')
        expect(await readFile(from, 'utf8')).toBe('previous')
    })

    test('moves a file symlink itself, keeping its identity and its target', async () => {
        const target = await sandbox.file('target', 'data')
        const from = join(sandbox.root, 'link')
        await symlink(target, from, 'file')
        const identity = entryIdentity(await lstat(from, { bigint: true }))
        const to = join(sandbox.root, 'moved')
        await moveExclusive(from, to)
        expect(await pathExists(from)).toBe(false)
        expect(entryIdentity(await lstat(to, { bigint: true }))).toBe(identity)
        expect(await readlink(to)).toBe(target)
        expect(await readFile(target, 'utf8')).toBe('data')
    })

    test('classifies each link by its stored reparse tag without following it', async () => {
        const directory = await sandbox.directory('folder')
        const file = await sandbox.file('file', 'data')
        const links: readonly (readonly [ReparsePointKind, string, 'junction' | 'dir' | 'file'])[] = [
            ['junction', directory, 'junction'],
            ['directory-symlink', directory, 'dir'],
            ['file-symlink', file, 'file']
        ]
        for (const [kind, target, type] of links) {
            const path = join(sandbox.root, kind)
            await symlink(target, path, type)
            expect(reparsePointKind(path)).toBe(kind)
        }
        expect(reparsePointKind(directory)).toBeNull()
        expect(reparsePointKind(file)).toBeNull()
    })

    test('refuses to replace an existing file symlink', async () => {
        const from = await sandbox.file('aside', 'previous')
        const to = join(sandbox.root, 'original')
        await symlink(await sandbox.file('target', 'data'), to, 'file')
        expect(hasErrorCode(await rejection(moveExclusive(from, to)), 'EEXIST')).toBe(true)
        expect((await lstat(to)).isSymbolicLink()).toBe(true)
        expect(await readFile(from, 'utf8')).toBe('previous')
    })
})
