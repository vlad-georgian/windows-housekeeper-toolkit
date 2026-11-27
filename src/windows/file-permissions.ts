import { runPowerShell } from './powershell.ts'

interface PermissionPath {
    readonly path: string
    readonly kind: 'directory' | 'file'
}

function isPermissionDescriptor(value: unknown): value is string {
    return typeof value === 'string' && /^O:[^:]+G:[^:]+D:/u.test(value) && !value.includes('NO_ACCESS_CONTROL')
}

/** Reads the owner, group, and discretionary ACL for each path in the supplied order. */
export async function readWindowsFilePermissions(paths: readonly PermissionPath[]): Promise<readonly string[]> {
    try {
        const output = await runPowerShell(
            `
            $sections = [Security.AccessControl.AccessControlSections]'Owner, Group, Access'
            $descriptors = @(foreach ($entry in $data.paths) {
                try {
                    $acl = if ($entry.kind -eq 'directory') {
                        [IO.Directory]::GetAccessControl($entry.path, $sections)
                    } else {
                        [IO.File]::GetAccessControl($entry.path, $sections)
                    }
                    $acl.GetSecurityDescriptorSddlForm($sections)
                } catch {
                    throw "Cannot read Windows permissions at $($entry.path): $($_.Exception.Message)"
                }
            })
            ConvertTo-Json -InputObject $descriptors -Compress
            `,
            { paths },
            60_000
        )
        const descriptors: unknown = JSON.parse(output)
        if (Array.isArray(descriptors) && descriptors.length === paths.length && descriptors.every(isPermissionDescriptor)) return descriptors
        throw new Error('Windows returned an incomplete access-control descriptor.')
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not verify Windows permissions at ${paths[0]?.path ?? 'the requested paths'}. ${detail}`, { cause: error })
    }
}
