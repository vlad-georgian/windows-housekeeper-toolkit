import { expect, test } from 'bun:test'

import { createSandbox } from '../test-support/fixtures.ts'
import { rejectionMessage } from '../test-support/rejection.ts'
import { runPowerShell } from '../windows/powershell.ts'
import { snapshotTree, verifyTree } from './tree.ts'

test.each([
    { change: 'a nested directory write denial', kind: 'directory', rights: 'WriteData', type: 'Deny' },
    { change: 'a nested file write denial', kind: 'file', rights: 'WriteData', type: 'Deny' },
    { change: 'a file execute denial', kind: 'file', rights: 'ExecuteFile', type: 'Deny' },
    { change: 'broader access to a nested directory', kind: 'directory', rights: 'Modify', type: 'Allow' }
] as const)(
    'rejects $change',
    async ({ kind, rights, type }) => {
        const sandbox = await createSandbox()
        try {
            const root = await sandbox.directory('copy')
            const nested = await sandbox.directory('copy/nested')
            const file = await sandbox.file('copy/nested/app.exe', 'fixture contents')
            const restricted = kind === 'directory' ? nested : file
            const manifest = await snapshotTree(root)
            const aclType = kind === 'directory' ? '[IO.Directory]' : '[IO.File]'
            const originalAcl = await runPowerShell(`(${aclType}::GetAccessControl($data.path)).GetSecurityDescriptorSddlForm('Access')`, { path: restricted })

            try {
                await runPowerShell(
                    `
                $principal = if ($data.type -eq 'Allow') { [Security.Principal.SecurityIdentifier]::new('S-1-1-0') } else { [Security.Principal.WindowsIdentity]::GetCurrent().User }
                $acl = ${aclType}::GetAccessControl($data.path)
                $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, $data.rights, $data.type)
                $acl.AddAccessRule($rule)
                ${aclType}::SetAccessControl($data.path, $acl)
                `,
                    { path: restricted, rights, type }
                )

                expect(await rejectionMessage(verifyTree(root, manifest))).toContain(restricted)
            } finally {
                await runPowerShell(
                    `
                $acl = ${aclType}::GetAccessControl($data.path)
                $acl.SetSecurityDescriptorSddlForm($data.sddl, 'Access')
                ${aclType}::SetAccessControl($data.path, $acl)
                `,
                    { path: restricted, sddl: originalAcl }
                )
            }
        } finally {
            await sandbox.dispose()
        }
    },
    15_000
)
