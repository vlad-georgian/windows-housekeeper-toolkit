import type { CleanupSession } from '../cleanup/operations.ts'
import { createCleanupOperations } from '../cleanup/operations.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { AppCleaner } from '../core/types.ts'
import { createStartupOperation } from '../startup/operation.ts'
import { createServiceStartupProvider } from '../startup/service-provider.ts'
import { createSignInStartupProvider } from '../startup/signin-provider.ts'
import type { StartupProvider } from '../startup/types.ts'
import { createSystemServiceBackend } from '../windows/app-services/backend.ts'
import { createSystemStartupBackend } from '../windows/app-startup/backend.ts'
import type { LaunchOperation } from './types.ts'

export interface LaunchContext {
    readonly paths: SystemPaths
    readonly cleaners: readonly AppCleaner[]
    readonly cleanup: CleanupSession
    /** Startup sources. Defaults to Windows sign-in entries and vetted app services. Tests inject fakes. */
    readonly startup?: readonly StartupProvider[]
}

/**
 * The launch-menu operations in menu order. Add an operation by implementing
 * `LaunchOperation` in its own module and listing it here.
 */
export function createLaunchOperations(context: LaunchContext): LaunchOperation[] {
    const startup = context.startup ?? [
        createSignInStartupProvider(context.paths, createSystemStartupBackend(context.paths)),
        createServiceStartupProvider(context.paths, createSystemServiceBackend())
    ]
    return [...createCleanupOperations(context.cleaners, context.cleanup), createStartupOperation(startup, context.cleanup)]
}
