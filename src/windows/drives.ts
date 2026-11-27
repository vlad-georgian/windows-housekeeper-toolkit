import type { DriveKind } from '../relocation/layout.ts'
import { runPowerShell } from './powershell.ts'

const kinds: Readonly<Record<string, DriveKind>> = {
    Fixed: 'fixed',
    Removable: 'removable',
    Network: 'network',
    Substituted: 'substituted'
}

/**
 * Reads a drive root's type from Windows. A `subst` mapping reports as fixed, so it is detected
 * from `subst.exe`'s list of the current session's mappings.
 */
export async function windowsDriveType(root: string): Promise<DriveKind> {
    if (!/^[a-z]:\\$/i.test(root)) return 'other'
    const output = await runPowerShell(
        `
      $root = [string]$data.root
      $letter = $root.Substring(0, 2)
      $mapped = @(& (Join-Path $env:SystemRoot 'System32\\subst.exe')) | Where-Object { $_.StartsWith("$letter\\: =>", [StringComparison]::OrdinalIgnoreCase) }
      if ($mapped) { 'Substituted' } else { [string]([IO.DriveInfo]::new($root).DriveType) }
    `,
        { root },
        5_000
    )
    return kinds[output] ?? 'other'
}
