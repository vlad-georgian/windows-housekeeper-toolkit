import { describe, expect, test } from 'bun:test'

import { nativeEntryIdentity } from './reclaim-tree.ts'

describe('native reclamation identity', () => {
    test('prints a high-bit file ID and volume serial unsigned, as GetFileInformationByHandle reports them', () => {
        // Bun reports these Windows IDs as negative numbers when their high bit is set.
        const identity = nativeEntryIdentity({ dev: -2n, ino: -1n, birthtimeNs: 0n })
        expect(identity).toEqual({ inode: '18446744073709551615', volume: '4294967294', created: '116444736000000000' })
    })

    test('converts the creation time to a Win32 FILETIME', () => {
        expect(nativeEntryIdentity({ dev: 7n, ino: 9n, birthtimeNs: 1_000n }).created).toBe('116444736000000010')
    })
})
