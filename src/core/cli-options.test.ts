import { describe, expect, test } from 'bun:test'

import { parseCliOptions } from './cli-options.ts'

describe('cleanup CLI options', () => {
    test('runs interactively when no category is named', () => {
        expect(parseCliOptions([]).categories).toEqual([])
    })

    test('names cleanup categories for an unattended run', () => {
        const options = parseCliOptions(['--category', 'general-cache', '--category', 'destructive-cache', '--dry-run'])
        expect(options.categories).toEqual(['general-cache', 'destructive-cache'])
        expect(options.dryRun).toBe(true)
    })

    test('collapses a category named twice', () => {
        const options = parseCliOptions(['--category', 'old-installations', '--category', 'old-installations'])
        expect(options.categories).toEqual(['old-installations'])
    })
})
