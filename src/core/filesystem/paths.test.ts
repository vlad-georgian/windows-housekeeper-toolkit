import { describe, expect, test } from 'bun:test'

import { entryIdentity, fileIndex, volumeSerial } from './paths.ts'

// Bun reports Windows file IDs and volume serials with their high bit set as negative numbers.
const highBitStats = { dev: -1_234_567n, ino: -42n, birthtimeNs: 1_700_000_000_000_000_000n }

describe('filesystem identity', () => {
    test('reads file IDs and volume serials as unsigned, as Windows reports them', () => {
        expect(fileIndex(highBitStats)).toBe(2n ** 64n - 42n)
        expect(volumeSerial(highBitStats)).toBe(2n ** 32n - 1_234_567n)
        expect(entryIdentity(highBitStats)).toBe(`${2n ** 32n - 1_234_567n}:${2n ** 64n - 42n}:1700000000000000000`)
    })

    test('leaves IDs without the high bit unchanged', () => {
        const stats = { dev: 3_000_000_000n, ino: 9_007_199_254_740_993n, birthtimeNs: 5n }
        expect(entryIdentity(stats)).toBe('3000000000:9007199254740993:5')
    })

    test('gives the same identity for a sign-extended and an unsigned report of one file', () => {
        const unsigned = { dev: 2n ** 32n - 1_234_567n, ino: 2n ** 64n - 42n, birthtimeNs: highBitStats.birthtimeNs }
        expect(entryIdentity(highBitStats)).toBe(entryIdentity(unsigned))
    })
})
