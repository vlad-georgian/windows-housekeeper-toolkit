import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
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

describe('Vite+ install lock', () => {
    test('never creates the lock file, so a missing lock cannot be acquired', async () => {
        const path = join(sandbox.root, '.install.lock')
        expect(await acquireInstallLock(path)).toBeNull()
    })

    test('is exclusive: a second acquisition fails until the first is released', async () => {
        const path = await sandbox.file('.install.lock', '')
        const release = await acquireInstallLock(path)
        expect(release).not.toBeNull()
        expect(await acquireInstallLock(path)).toBeNull()

        release?.()
        const again = await acquireInstallLock(path)
        expect(again).not.toBeNull()
        again?.()
    })

    test('keeps another process from taking the lock Vite+ takes while it is held', async () => {
        const path = await sandbox.file('.install.lock', '')
        const release = await acquireInstallLock(path)
        const contender = powershell(`${open}; try { $fs.Lock(0, [long]::MaxValue); 'acquired' } catch { 'blocked' }`, path)
        try {
            expect(await firstLine(contender)).toBe('blocked')
        } finally {
            release?.()
            contender.kill()
            await contender.exited
        }
    })

    test('cannot be acquired while another process holds it', async () => {
        const path = await sandbox.file('.install.lock', '')
        const holder = powershell(`${open}; $fs.Lock(0, [long]::MaxValue); 'locked'; Start-Sleep 30`, path)
        try {
            expect(await firstLine(holder)).toBe('locked')
            expect(await acquireInstallLock(path)).toBeNull()
        } finally {
            holder.kill()
            await holder.exited
        }
        const release = await acquireInstallLock(path)
        expect(release).not.toBeNull()
        release?.()
    })
})
