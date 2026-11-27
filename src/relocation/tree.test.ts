import { expect, test } from 'bun:test'

import { createSandbox } from '../test-support/fixtures.ts'
import { rejectionMessage } from '../test-support/rejection.ts'
import { runPowerShell } from '../windows/powershell.ts'
import { snapshotTree, verifyTree } from './tree.ts'

test.each(['directory', 'file'] as const)(
    'rejects a Windows write denial on a nested %s',
    async (kind) => {
        const sandbox = await createSandbox()
        try {
            const root = await sandbox.directory('copy')
            const nested = await sandbox.directory('copy/nested')
            const file = await sandbox.file('copy/nested/data.txt', 'data')
            const restricted = kind === 'directory' ? nested : file
            const manifest = await snapshotTree(root)
            const aclType = kind === 'directory' ? '[IO.Directory]' : '[IO.File]'
            const originalAcl = await runPowerShell(`(${aclType}::GetAccessControl($data.path)).GetSecurityDescriptorSddlForm('Access')`, { path: restricted })

            try {
                await runPowerShell(
                    `
                $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
                $acl = ${aclType}::GetAccessControl($data.path)
                $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, 'WriteData', 'Deny')
                $acl.AddAccessRule($rule)
                ${aclType}::SetAccessControl($data.path, $acl)
                `,
                    { path: restricted }
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
