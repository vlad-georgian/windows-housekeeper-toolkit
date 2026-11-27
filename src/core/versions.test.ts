import { describe, expect, test } from 'bun:test'

import { compareSemver } from './versions.ts'

describe('semantic version precedence', () => {
    test('orders the SemVer specification examples', () => {
        const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
        for (let index = 1; index < ordered.length; index += 1) {
            const lower = ordered[index - 1] ?? ''
            const higher = ordered[index] ?? ''
            expect(compareSemver(lower, higher)).toBeLessThan(0)
            expect(compareSemver(higher, lower)).toBeGreaterThan(0)
        }
    })

    test('treats a release as newer than its own prerelease, and ignores build metadata', () => {
        expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
        expect(compareSemver('1.0.0-RC.1', '1.0.0-rc.1')).not.toBe(0)
        expect(compareSemver('1.0.0+force.1.2', '1.0.0')).toBe(0)
    })

    test('returns null for text that is not a version', () => {
        expect(compareSemver('1.0', '1.0.0')).toBeNull()
        expect(compareSemver('1.0.0', 'latest')).toBeNull()
    })
})
