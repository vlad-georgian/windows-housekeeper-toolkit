import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { hasErrorCode } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { RelocatableApp } from '../types.ts'
import { directEntry, overlaps, type PackageEnvironment, type PackageSources, userPath } from './package-evidence.ts'

export type MachineChocolateyRoot = PackageSources['machineChocolatey']

export function chocolateyRelocation(paths: SystemPaths, env: PackageEnvironment, machineRoot: MachineChocolateyRoot): RelocatableApp {
    const root = userPath(env.ChocolateyInstall, paths)
    return {
        id: 'chocolatey',
        label: 'Chocolatey (per-user)',
        processGuardId: 'chocolatey-cache',
        paths: root
            ? [
                  {
                      path: join(root, 'lib'),
                      description: 'per-user Chocolatey packages',
                      async verifyDirectory(target) {
                          const machine = await machineRoot()
                          if (machine === null) return false
                          if (machine && (!isAbsolute(machine) || overlaps(root, machine))) return false
                          if (machine) {
                              try {
                                  const physicalMachine = await realpath(machine)
                                  if (overlaps(physicalMachine, root) || overlaps(physicalMachine, target)) return false
                              } catch (error) {
                                  if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return false
                              }
                          }
                          return (
                              (await directEntry(join(root, 'bin', 'choco.exe'), 'file')) &&
                              (await directEntry(join(root, 'config', 'chocolatey.config'), 'file')) &&
                              (await directEntry(join(target, 'chocolatey', 'chocolatey.nuspec'), 'file'))
                          )
                      }
                  }
              ]
            : []
    }
}
