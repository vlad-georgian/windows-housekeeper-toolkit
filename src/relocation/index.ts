import type { CleanupSession } from '../cleanup/operations.ts'
import { errorMessage } from '../core/format.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { LaunchOperation } from '../launch/types.ts'
import { windowsDriveType } from '../windows/drives.ts'
import { listWindowsProcesses } from '../windows/processes.ts'
import { createRelocationCatalog } from './apps/index.ts'
import { createRecoveryJournal } from './journal.ts'
import { differentVolumes } from './layout.ts'
import { createRelocationOperation, type RelocationEvent } from './operation.ts'

function auditDetails(event: RelocationEvent): Record<string, unknown> {
    return event.kind === 'failed' ? { ...event, error: errorMessage(event.error) } : { ...event }
}

/** The launch-menu relocation operation for the current user, recorded in the run's audit log. */
export function createRelocationLaunchOperation(paths: SystemPaths, session: CleanupSession): LaunchOperation {
    const catalog = createRelocationCatalog(paths)
    const labelOf = (appId: string): string => catalog.find((app) => app.id === appId)?.label ?? appId
    return createRelocationOperation({
        home: paths.home,
        catalog,
        journal: createRecoveryJournal(paths),
        dryRun: session.dryRun,
        listProcesses: listWindowsProcesses,
        volumesDiffer: differentVolumes,
        driveType: windowsDriveType,
        async report(event) {
            await session.audit.recordRelocation(event.kind, auditDetails(event))
            if (event.kind === 'skipped') session.summary.skippedApps.add(labelOf(event.appId))
            if (event.kind === 'failed') {
                session.summary.failures++
                session.summary.failedApps.add(labelOf(event.appId))
            }
        }
    })
}
