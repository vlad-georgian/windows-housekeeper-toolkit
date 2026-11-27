import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { realpath, rename, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { pathExists } from '../../core/filesystem/index.ts'
import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { rejection } from '../../test-support/rejection.ts'
import { acquireInstallLock } from './vite-plus-install-lock.ts'

let sandbox: Sandbox

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

/** A PowerShell child that tries to take, or holds, an exclusive byte-range lock as Vite+ does. */
function powershell(script: string, path: string) {
    return Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
        stdout: 'pipe',
        stderr: 'ignore',
        windowsHide: true,
        env: { ...process.env, LOCK_PATH: path }
    })
}

async function firstLine(child: ReturnType<typeof powershell>): Promise<string> {
    const reader = child.stdout.getReader()
    const first = await reader.read()
    return new TextDecoder().decode(first.value).trim()
}

const open = `$fs = [IO.File]::Open($env:LOCK_PATH, 'Open', 'ReadWrite', 'ReadWrite')`

/** A store directory holding Vite+'s lock file, returned as the canonical store and the lock path. */
async function store(): Promise<{ directory: string; lock: string }> {
    const lock = await sandbox.file(join('Users', 'test', 'store', '.install.lock'), '')
    return { directory: await realpath(dirname(lock)), lock }
}

describe('Vite+ install lock', () => {
    test('never creates the lock file, so a missing lock cannot be acquired', async () => {
        const directory = await sandbox.directory('empty-store')
        expect(await acquireInstallLock(directory)).toBeNull()
        expect(await pathExists(join(directory, '.install.lock'))).toBe(false)
    })

    test('is exclusive: a second acquisition fails until the first is released', async () => {
        const { directory } = await store()
        const release = await acquireInstallLock(directory)
        expect(release).not.toBeNull()
        expect(await acquireInstallLock(directory)).toBeNull()

        release?.()
        const again = await acquireInstallLock(directory)
        expect(again).not.toBeNull()
        again?.()
    })

    test('keeps another process from taking the lock Vite+ takes while it is held', async () => {
        const { directory, lock } = await store()
        const release = await acquireInstallLock(directory)
        const contender = powershell(`${open}; try { $fs.Lock(0, [long]::MaxValue); 'acquired' } catch { 'blocked' }`, lock)
        try {
            expect(await firstLine(contender)).toBe('blocked')
        } finally {
            release?.()
            contender.kill()
            await contender.exited
        }
    })

    test('cannot be acquired while another process holds it', async () => {
        const { directory, lock } = await store()
        const holder = powershell(`${open}; $fs.Lock(0, [long]::MaxValue); 'locked'; Start-Sleep 30`, lock)
        try {
            expect(await firstLine(holder)).toBe('locked')
            expect(await acquireInstallLock(directory)).toBeNull()
        } finally {
            holder.kill()
            await holder.exited
        }
        const release = await acquireInstallLock(directory)
        expect(release).not.toBeNull()
        release?.()
    })

    test('keeps the held lock file bound to its path: it cannot be renamed aside and replaced', async () => {
        const { directory, lock } = await store()
        const release = await acquireInstallLock(directory)
        try {
            expect(await rejection(rename(lock, `${lock}.aside`))).toBeInstanceOf(Error)
            expect(await pathExists(lock)).toBe(true)
            expect(await pathExists(`${lock}.aside`)).toBe(false)
        } finally {
            release?.()
        }
        await rename(lock, `${lock}.aside`)
    })

    test('keeps the store bound to its path: it cannot be renamed while the lock is held', async () => {
        const { directory } = await store()
        const release = await acquireInstallLock(directory)
        try {
            expect(await rejection(rename(directory, `${directory}-moved`))).toBeInstanceOf(Error)
            expect(await pathExists(directory)).toBe(true)
        } finally {
            release?.()
        }
        await rename(directory, `${directory}-moved`)
    })

    test('refuses a lock that is a link, and a store reached through a link', async () => {
        const { directory, lock } = await store()
        const elsewhere = await sandbox.file(join('Users', 'test', 'elsewhere', 'real.lock'), '')
        await rename(lock, `${lock}.aside`)
        await symlink(elsewhere, lock)
        expect(await acquireInstallLock(directory)).toBeNull()

        const alias = join(sandbox.root, 'Users', 'test', 'alias')
        await symlink(directory, alias, 'junction')
        expect(await acquireInstallLock(alias)).toBeNull()
    })
})
