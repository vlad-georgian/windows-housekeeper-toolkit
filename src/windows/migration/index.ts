import type { SystemPaths } from '../../core/system-paths.ts'
import { migrationRecord } from './journal.ts'
import { finishMove, startMove } from './move.ts'
import { finishRollback } from './rollback.ts'
import { showStatus } from './status.ts'

export async function runMigration(paths: SystemPaths, args: readonly string[]): Promise<void> {
    const [action, candidate, flag, destination] = args
    const valid =
        args.length === 0 ||
        (action === 'status' && args.length === 1) ||
        (candidate === 'codex-logs' &&
            ((action === 'move' && args.length === 4 && flag === '--destination' && destination) || (['rollback', 'resume'].includes(action ?? '') && args.length === 2)))
    if (!valid) {
        throw new Error('Use migration status, migration move codex-logs --destination PATH, migration resume codex-logs, or migration rollback codex-logs.')
    }
    const operation = await migrationRecord(paths)
    if (!action || action === 'status') return showStatus(paths, operation)

    if (action === 'move' && destination) return startMove(paths, operation, destination)

    if (!operation || operation.phase === 'rolled-back') throw new Error('No Codex migration is available to recover.')
    if (action === 'rollback' || ['rolling-back', 'restoring-setting'].includes(operation.phase)) {
        return finishRollback(paths, operation)
    }
    if (operation.phase === 'moved') throw new Error('The move is complete. Use migration rollback codex-logs to restore it.')
    return finishMove(paths, operation)
}
