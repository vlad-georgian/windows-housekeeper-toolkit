import type { CleanupSession } from '../cleanup/operations.ts'
import { createCleanupOperations } from '../cleanup/operations.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { AppCleaner } from '../core/types.ts'
import { createRelocationLaunchOperation } from '../relocation/index.ts'
import type { LaunchOperation } from './types.ts'

export interface LaunchContext {
    readonly paths: SystemPaths
    readonly cleaners: readonly AppCleaner[]
    readonly cleanup: CleanupSession
}

/**
 * The launch-menu operations in menu order. Add an operation by implementing
 * `LaunchOperation` in its own module and listing it here.
 */
export function createLaunchOperations(context: LaunchContext): LaunchOperation[] {
    return [...createCleanupOperations(context.cleaners, context.cleanup), createRelocationLaunchOperation(context.paths, context.cleanup)]
}
