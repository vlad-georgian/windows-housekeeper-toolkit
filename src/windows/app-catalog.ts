import { join } from 'node:path'

import type { SystemPaths } from '../core/system-paths.ts'
import { appInventoryScript } from './app-inventory-script.ts'
import { runPowerShell } from './powershell.ts'

export const appIds = ['codex', 'claude', 't3-code', 'opencode'] as const
export type AppId = (typeof appIds)[number]

export const appNames: Record<AppId, string> = {
    codex: 'Codex',
    claude: 'Claude',
    't3-code': 'T3 Code',
    opencode: 'OpenCode'
}

export function isAppId(value: unknown): value is AppId {
    return appIds.some((app) => app === value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
    return Array.isArray(value) && value.every(guard)
}

export function isString(value: unknown): value is string {
    return typeof value === 'string'
}

export function parseInventoryResult<T>(output: string, guard: (value: unknown) => value is T): T {
    const result: unknown = JSON.parse(output)
    if (!guard(result)) throw new Error('Unexpected Windows app inventory response.')
    return result
}

// Use the Task Scheduler API directly so inventory does not depend on the CIM provider.
export const scheduledTaskScript = String.raw`
  function Get-FolderTasks($folder) {
    foreach ($task in $folder.GetTasks(1)) { $task }
    foreach ($child in $folder.GetFolders(0)) { Get-FolderTasks $child }
  }
  function Get-VisibleTasks {
    $service = New-Object -ComObject Schedule.Service
    $service.Connect()
    Get-FolderTasks ($service.GetFolder('\'))
  }
`

interface Installation {
    id: AppId
    type: string
    path: string
}

interface PackageInstallation {
    id: AppId
    family: string
    fullName: string
    location: string
    signature: string
    registered: boolean
    tasks: { name: string; label: string }[]
}

interface AppService {
    id: AppId
    name: string
    status: string
    start: string
}

export interface AppInventory {
    installs: Installation[]
    packages: PackageInstallation[]
    services: AppService[]
    warnings: string[]
}

export const packageIdentities = [
    { id: 'codex', name: 'OpenAI.Codex', family: 'OpenAI.Codex_2p2nqsd0c76g0' },
    { id: 'claude', name: 'Claude', family: 'Claude_pzs8sxrjxfjjc' }
] as const

export const appServiceIdentities = [
    { id: 'codex', name: 'CodexSandboxService.OpenAI.Codex', file: 'codex-windows-sandbox-service.exe', signer: 'OpenAI OpCo, LLC' },
    { id: 'claude', name: 'CoworkVMService', file: 'cowork-svc.exe', signer: 'Anthropic, PBC' }
] as const

function isInstallation(value: unknown): value is Installation {
    return isRecord(value) && isAppId(value.id) && isString(value.type) && isString(value.path)
}

function isPackagedTask(value: unknown): value is PackageInstallation['tasks'][number] {
    return isRecord(value) && isString(value.name) && isString(value.label)
}

function isPackage(value: unknown): value is PackageInstallation {
    return (
        isRecord(value) &&
        isAppId(value.id) &&
        isString(value.family) &&
        isString(value.fullName) &&
        isString(value.location) &&
        isString(value.signature) &&
        typeof value.registered === 'boolean' &&
        isArrayOf(value.tasks, isPackagedTask)
    )
}

function isService(value: unknown): value is AppService {
    return isRecord(value) && isAppId(value.id) && isString(value.name) && isString(value.status) && isString(value.start)
}

function isInventory(value: unknown): value is AppInventory {
    return (
        isRecord(value) &&
        isArrayOf(value.installs, isInstallation) &&
        isArrayOf(value.packages, isPackage) &&
        isArrayOf(value.services, isService) &&
        isArrayOf(value.warnings, isString)
    )
}

export async function getAppInventory(paths: SystemPaths): Promise<AppInventory> {
    const programs = join(paths.localAppData, 'Programs')
    const installs = [
        {
            id: 't3-code',
            type: 'desktop',
            path: join(programs, 't3code', 'T3 Code (Beta).exe'),
            product: 'T3 Code (Beta)',
            publisher: 'T3 Tools'
        },
        {
            id: 't3-code',
            type: 'desktop',
            path: join(programs, 't3code', 'T3 Code.exe'),
            product: 'T3 Code',
            publisher: 'T3 Tools'
        },
        {
            id: 'opencode',
            type: 'desktop',
            path: join(programs, 'ai.opencode.desktop', 'OpenCode.exe'),
            product: 'OpenCode',
            publisher: 'OpenCode'
        },
        {
            id: 'codex',
            type: 'standalone CLI',
            path: join(programs, 'OpenAI', 'Codex', 'bin', 'codex.exe')
        },
        { id: 'claude', type: 'native CLI', path: join(paths.home, '.local', 'bin', 'claude.exe') },
        { id: 'opencode', type: 'Bun CLI', path: join(paths.home, '.bun', 'bin', 'opencode.exe') }
    ]
    const scoop = process.env.SCOOP ?? join(paths.home, 'scoop')
    const npm = join(scoop, 'apps', 'nodejs', 'current', 'bin', 'node_modules', '@openai', 'codex')
    const data = {
        installs,
        npmPackage: join(npm, 'package.json'),
        packages: packageIdentities,
        services: appServiceIdentities
    }
    const output = await runPowerShell(appInventoryScript, data)
    return parseInventoryResult(output, isInventory)
}
