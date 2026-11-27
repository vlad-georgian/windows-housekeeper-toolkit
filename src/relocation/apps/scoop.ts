import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { isPathInside, isUnavailablePath } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { directEntry, type PackageEnvironment, samePath, userPath } from './package-evidence.ts'

export function scoopRelocation(paths: SystemPaths, env: PackageEnvironment): RelocatableApp {
    const root = userPath(env.SCOOP ?? join(paths.home, 'scoop'), paths)
    const global = env.SCOOP_GLOBAL ?? join(paths.programData, 'scoop')
    return {
        id: 'scoop',
        label: 'Scoop',
        processGuardId: 'scoop-relocation',
        paths:
            root && !samePath(root, global) && !isPathInside(root, global) && !isPathInside(global, root)
                ? [
                      {
                          path: join(root, 'apps'),
                          description: 'installed Scoop apps',
                          async verifyDirectory(target) {
                              const releases = join(target, 'scoop')
                              if (!(await directEntry(releases, 'directory'))) return false
                              try {
                                  const current = await realpath(join(releases, 'current'))
                                  if (!isPathInside(current, releases)) return false
                                  return directEntry(join(current, 'bin', 'scoop.ps1'), 'file')
                              } catch (error) {
                                  if (isUnavailablePath(error)) return false
                                  throw error
                              }
                          }
                      }
                  ]
                : []
    }
}
