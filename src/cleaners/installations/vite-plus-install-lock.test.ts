import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../../test-support/fixtures.ts'
import { isInstallLockHeld } from './vite-plus-install-lock.ts'

let sandbox: Sandbox

beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

describe('Vite+ install lock probe', () => {
    test('reports no lock when the lock file is absent or free', async () => {
        const path = join(sandbox.root, '.install.lock')
        expect(await isInstallLockHeld(path)).toBe(false)

        await sandbox.file('.install.lock', '')
        expect(await isInstallLockHeld(path)).toBe(false)
    })

    test('reports a lock held by another process, as Vite+ takes it with an exclusive byte-range lock', async () => {
        const path = await sandbox.file('.install.lock', '')
        // Holds the same kind of exclusive lock that Vite+ takes while it changes releases.
        const holder = Bun.spawn(
            [
                'powershell',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `$fs = [IO.File]::Open($env:LOCK_PATH, 'Open', 'ReadWrite', 'ReadWrite'); $fs.Lock(0, [long]::MaxValue); Write-Output locked; Start-Sleep 30`
            ],
            { stdout: 'pipe', stderr: 'ignore', windowsHide: true, env: { ...process.env, LOCK_PATH: path } }
        )
        try {
            const reader = holder.stdout.getReader()
            const first = await reader.read()
            expect(new TextDecoder().decode(first.value)).toContain('locked')

            expect(await isInstallLockHeld(path)).toBe(true)
        } finally {
            holder.kill()
            await holder.exited
        }
        expect(await isInstallLockHeld(path)).toBe(false)
    })
})
