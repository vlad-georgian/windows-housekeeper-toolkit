import { appServiceIdentities, isAppId, isArrayOf, isRecord, isString, packageIdentities, parseInventoryResult, type AppId } from '../app-catalog.ts'
import { runPowerShell } from '../powershell.ts'
import { appServiceScript } from './script.ts'

export type AutomaticMode = 'Automatic' | 'Automatic (Delayed Start)'
export type ServiceStartupMode = AutomaticMode | 'Manual' | 'Disabled'

export interface AppService {
    readonly app: AppId
    readonly name: string
    readonly packageFullName: string
    readonly imagePath: string
    readonly binaryHash: string
    readonly mode: ServiceStartupMode
}

export interface ServiceSnapshot {
    readonly elevated: boolean
    readonly services: readonly AppService[]
    readonly warnings: readonly string[]
}

/** The backend confirmed that it rejected the request before attempting an SCM mutation. */
export class ServiceChangeRejectedError extends Error {}

export interface ServiceBackend {
    inspect(): Promise<ServiceSnapshot>
    /** Rechecks eligibility before changing startup configuration. Only a confirmed pre-write rejection uses ServiceChangeRejectedError. */
    changeMode(expected: AppService, mode: Exclude<ServiceStartupMode, 'Disabled'>): Promise<void>
}

export function isAutomatic(mode: unknown): mode is AutomaticMode {
    return mode === 'Automatic' || mode === 'Automatic (Delayed Start)'
}

export function isAppService(value: unknown): value is AppService {
    return (
        isRecord(value) &&
        isAppId(value.app) &&
        typeof value.name === 'string' &&
        value.name.length > 0 &&
        typeof value.packageFullName === 'string' &&
        value.packageFullName.length > 0 &&
        typeof value.imagePath === 'string' &&
        value.imagePath.length > 0 &&
        typeof value.binaryHash === 'string' &&
        /^[0-9a-f]{64}$/i.test(value.binaryHash) &&
        (isAutomatic(value.mode) || value.mode === 'Manual' || value.mode === 'Disabled')
    )
}

export function sameService(left: AppService, right: AppService): boolean {
    return (
        left.name === right.name &&
        left.app === right.app &&
        left.packageFullName === right.packageFullName &&
        left.imagePath === right.imagePath &&
        left.binaryHash === right.binaryHash
    )
}

function isServiceSnapshot(value: unknown): value is ServiceSnapshot {
    return isRecord(value) && typeof value.elevated === 'boolean' && isArrayOf(value.services, isAppService) && isArrayOf(value.warnings, isString)
}

function isPreWriteRejection(value: unknown): value is { rejectedBeforeWrite: string } {
    return isRecord(value) && typeof value.rejectedBeforeWrite === 'string' && value.rejectedBeforeWrite.length > 0
}

export function createSystemServiceBackend(): ServiceBackend {
    const identities = appServiceIdentities.map(({ id, name, file, signer }) => ({
        id,
        name,
        file,
        signer,
        package: packageIdentities.find((identity) => identity.id === id)
    }))
    return {
        async inspect() {
            return parseInventoryResult(await runPowerShell(appServiceScript, { identities }, 30_000), isServiceSnapshot)
        },
        async changeMode(expected, mode) {
            const output = await runPowerShell(appServiceScript, { identities, expected, mode }, 30_000)
            if (output === 'verified') return
            const { rejectedBeforeWrite } = parseInventoryResult(output, isPreWriteRejection)
            throw new ServiceChangeRejectedError(rejectedBeforeWrite)
        }
    }
}
