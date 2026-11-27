import { afterEach, beforeEach, expect, test } from 'bun:test'

import { newSummary } from '../cleanup/summary.ts'
import { AuditLogger } from '../core/audit-logger.ts'
import { runLaunchMenu } from '../launch/menu.ts'
import { FakePrompts } from '../test-support/fake-prompts.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { ServiceChangeRejectedError, type AppService, type ServiceBackend, type ServiceStartupMode } from '../windows/app-services/backend.ts'
import { createStartupOperation } from './operation.ts'
import { createServiceStartupProvider } from './service-provider.ts'

const name = 'CoworkVMService'
const disable = 'disable:coworkvmservice'
const restore = 'restore:coworkvmservice'
const claude: AppService = {
    app: 'claude',
    name,
    packageFullName: 'Claude_1.0.0.0_x64__pzs8sxrjxfjjc',
    imagePath: String.raw`"C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__pzs8sxrjxfjjc\app\resources\cowork-svc.exe"`,
    binaryHash: 'a'.repeat(64),
    mode: 'Automatic'
}
const codex: AppService = {
    app: 'codex',
    name: 'CodexSandboxService.OpenAI.Codex',
    packageFullName: 'OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0',
    imagePath: String.raw`"C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0\app\resources\codex-windows-sandbox-service.exe"`,
    binaryHash: 'b'.repeat(64),
    mode: 'Automatic'
}

class FakeServices implements ServiceBackend {
    service: (AppService & { running: boolean }) | null = { ...claude, running: true }
    other: AppService = codex
    elevated = true
    interruptDelayedRestore = false
    replaceBeforeChange: typeof this.service = null
    loseDisableReply = false
    warnings: string[] = []

    inspect() {
        const services = [this.other]
        if (this.service) {
            const { running: _running, ...service } = this.service
            services.unshift(service)
        }
        return Promise.resolve({ elevated: this.elevated, services, warnings: this.warnings })
    }

    changeMode(expected: AppService, mode: ServiceStartupMode): Promise<void> {
        if (this.replaceBeforeChange) {
            this.service = this.replaceBeforeChange
            this.replaceBeforeChange = null
        }
        const current = this.service
        if (
            !this.elevated ||
            !current ||
            current.name !== expected.name ||
            current.packageFullName !== expected.packageFullName ||
            current.imagePath !== expected.imagePath ||
            current.binaryHash !== expected.binaryHash ||
            current.mode !== expected.mode
        ) {
            return Promise.reject(new ServiceChangeRejectedError('The service changed.'))
        }
        if (this.interruptDelayedRestore && mode === 'Automatic (Delayed Start)') {
            this.service = { ...current, mode: 'Automatic' }
            return Promise.reject(new Error('The delayed start flag could not be set.'))
        }
        this.service = { ...current, mode }
        if (this.loseDisableReply && mode === 'Manual') return Promise.reject(new Error('Lost the service configuration response.'))
        return Promise.resolve()
    }
}

let sandbox: Sandbox
beforeEach(async () => {
    sandbox = await createSandbox()
})
afterEach(() => sandbox.dispose())

async function menu(backend: FakeServices, prompts: FakePrompts, dryRun = false) {
    const summary = newSummary()
    const provider = createServiceStartupProvider(sandbox.paths, backend)
    const operation = createStartupOperation([provider], { audit: await AuditLogger.create(sandbox.root), summary, dryRun })
    const outcome = await runLaunchMenu([operation], prompts, { dryRun })
    return { outcome, failures: summary.failures }
}

test('previews a vetted service and changes Automatic to Manual only after confirmation', async () => {
    const machine = new FakeServices()
    const cancel = new FakePrompts([['startup'], [disable], null])
    expect((await menu(machine, cancel)).outcome).toBe('cancelled')
    expect(machine.service).toEqual({ ...claude, running: true })
    expect(cancel.checklists[1]?.initialValues).toEqual([])
    expect(cancel.notes.find((note) => note.title === 'Plan')?.lines.join('\n')).toMatch(/machine-wide.*administrator/is)
    expect(cancel.notes.find((note) => note.title === 'Plan')?.lines.join('\n')).toMatch(/CoworkVMService.*Automatic.*Manual/s)

    expect(await menu(machine, new FakePrompts([['startup'], [disable], true]))).toEqual({ outcome: 'applied', failures: 0 })
    expect(machine.service).toEqual({ ...claude, mode: 'Manual', running: true })
    expect(machine.other).toEqual(codex)
})

test('retries an interrupted delayed startup restore and verifies the exact original mode', async () => {
    const machine = new FakeServices()
    machine.other = { ...codex, mode: 'Manual' }
    const original = { ...claude, mode: 'Automatic (Delayed Start)' as const, running: true }
    machine.service = original
    expect((await menu(machine, new FakePrompts([['startup'], [disable], true]))).failures).toBe(0)
    expect(machine.service).toEqual({ ...original, mode: 'Manual' })

    const decline = new FakePrompts([['startup'], [restore], false])
    expect((await menu(machine, decline)).outcome).toBe('declined')
    expect(decline.notes.find((note) => note.title === 'Plan')?.lines.join('\n')).toContain('Manual → Automatic (Delayed Start)')
    expect(machine.service).toEqual({ ...original, mode: 'Manual' })

    machine.interruptDelayedRestore = true
    expect((await menu(machine, new FakePrompts([['startup'], [restore], true]))).failures).toBe(1)
    expect(machine.service).toEqual({ ...original, mode: 'Automatic' })

    machine.interruptDelayedRestore = false
    expect((await menu(machine, new FakePrompts([['startup'], [restore], true]))).failures).toBe(0)
    expect(machine.service).toEqual(original)
    const next = new FakePrompts([['startup'], []])
    await menu(machine, next)
    expect(next.checklists[1]?.options.map((option) => option.value)).toContain(disable)
    expect(next.checklists).toHaveLength(2)
})

test('omits unverifiable and Manual services, and reports why elevation is needed', async () => {
    const machine = new FakeServices()
    machine.service = null
    machine.other = { ...codex, mode: 'Manual' }
    machine.warnings = ['Could not verify CoworkVMService. The package does not declare the service.']
    const unknown = new FakePrompts([['startup']])
    expect((await menu(machine, unknown)).outcome).toBe('nothing-selected')
    expect(unknown.notes[0]?.lines).toEqual(machine.warnings)
    expect(unknown.checklists).toHaveLength(1)

    machine.elevated = false
    machine.service = { ...claude, running: true }
    const unelevated = new FakePrompts([['startup']])
    expect((await menu(machine, unelevated)).outcome).toBe('nothing-selected')
    expect(unelevated.notes[0]?.title).toMatch(/machine-wide.*administrator/i)
    expect(unelevated.checklists).toHaveLength(1)
})

test('cancels the service checklist and previews a dry run without saving a preference', async () => {
    const machine = new FakeServices()
    expect((await menu(machine, new FakePrompts([['startup'], null]))).outcome).toBe('cancelled')
    expect((await menu(machine, new FakePrompts([['startup'], [disable]]), true)).outcome).toBe('previewed')
    expect(machine.service).toEqual({ ...claude, running: true })
    const next = new FakePrompts([['startup'], []])
    await menu(machine, next)
    expect(next.checklists[1]?.options.map((option) => option.value)).toContain(disable)
    expect(next.checklists).toHaveLength(2)
})

test('refuses to change an executable replaced after confirmation was presented', async () => {
    const machine = new FakeServices()
    const replacement = { ...claude, binaryHash: 'c'.repeat(64), running: true }
    class ReplaceOnConfirmation extends FakePrompts {
        override confirm(): Promise<boolean> {
            machine.service = replacement
            return Promise.resolve(true)
        }
    }

    expect((await menu(machine, new ReplaceOnConfirmation([['startup'], [disable]]))).failures).toBe(1)
    expect(machine.service).toEqual(replacement)
    const next = new FakePrompts([['startup'], []])
    await menu(machine, next)
    expect(next.checklists[1]?.options.map((option) => option.value)).toContain(disable)
})

test('retries disable for an updated service after the backend confirms it rejected the previous change before writing', async () => {
    const machine = new FakeServices()
    machine.other = { ...codex, mode: 'Manual' }
    const updated = {
        ...claude,
        packageFullName: 'Claude_2.0.0.0_x64__pzs8sxrjxfjjc',
        imagePath: claude.imagePath.replace('1.0.0.0', '2.0.0.0'),
        binaryHash: 'c'.repeat(64),
        mode: 'Automatic (Delayed Start)' as const,
        running: true
    }
    machine.replaceBeforeChange = updated

    expect((await menu(machine, new FakePrompts([['startup'], [disable], true]))).failures).toBe(1)
    expect(machine.service).toEqual(updated)

    expect(await menu(machine, new FakePrompts([['startup'], [disable], true]))).toEqual({ outcome: 'applied', failures: 0 })
    expect(machine.service).toEqual({ ...updated, mode: 'Manual' })
    expect(await menu(machine, new FakePrompts([['startup'], [restore], true]))).toEqual({ outcome: 'applied', failures: 0 })
    expect(machine.service).toEqual(updated)
})

test('keeps the original mode when disable may have completed and retries restore after a confirmed pre-write rejection', async () => {
    const machine = new FakeServices()
    machine.other = { ...codex, mode: 'Manual' }
    machine.loseDisableReply = true
    const original = { ...claude, mode: 'Automatic (Delayed Start)' as const, running: true }
    machine.service = original

    expect((await menu(machine, new FakePrompts([['startup'], [disable], true]))).failures).toBe(1)
    const manual = { ...original, mode: 'Manual' as const }
    expect(machine.service).toEqual(manual)

    machine.replaceBeforeChange = { ...manual, binaryHash: 'c'.repeat(64) }
    expect((await menu(machine, new FakePrompts([['startup'], [restore], true]))).failures).toBe(1)
    expect(machine.service).toEqual({ ...manual, binaryHash: 'c'.repeat(64) })

    machine.service = manual
    expect(await menu(machine, new FakePrompts([['startup'], [restore], true]))).toEqual({ outcome: 'applied', failures: 0 })
    expect(machine.service).toEqual(original)
})

test('refuses to restore after the service identity changes and keeps the saved preference', async () => {
    const machine = new FakeServices()
    expect((await menu(machine, new FakePrompts([['startup'], [disable], true]))).failures).toBe(0)
    const manual = { ...claude, mode: 'Manual' as const, running: true }
    const replacement = { ...manual, packageFullName: 'Claude_2.0.0.0_x64__pzs8sxrjxfjjc' }
    class ReplaceOnConfirmation extends FakePrompts {
        override confirm(): Promise<boolean> {
            machine.service = replacement
            return Promise.resolve(true)
        }
    }

    expect((await menu(machine, new ReplaceOnConfirmation([['startup'], [], [restore]]))).failures).toBe(1)
    expect(machine.service).toEqual(replacement)
    const unverifiable = new FakePrompts([['startup'], []])
    await menu(machine, unverifiable)
    expect(unverifiable.notes[0]?.lines.join('\n')).toContain('Could not offer restore for CoworkVMService')

    machine.service = manual
    expect((await menu(machine, new FakePrompts([['startup'], [], [restore], true]))).failures).toBe(0)
    expect(machine.service).toEqual({ ...claude, running: true })
})
