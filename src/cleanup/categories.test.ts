import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createCleaners } from '../cleaners/index.ts'
import type { AppCleaner } from '../core/types.ts'
import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { categoriesForOperation, cleanersForCategories, resolveSignInCleaners } from './categories.ts'

let sandbox: Sandbox
let catalog: readonly AppCleaner[]

beforeEach(async () => {
    sandbox = await createSandbox()
    catalog = createCleaners(sandbox.paths)
})
afterEach(() => sandbox.dispose())

describe('sign-in cleanup selection', () => {
    test('never selects destructive caches or old installations, even when saved', () => {
        const { cleaners, excluded } = resolveSignInCleaners(
            catalog,
            catalog.map((cleaner) => cleaner.id)
        )
        expect(cleaners.length).toBeGreaterThan(0)
        expect(cleaners.every((cleaner) => cleaner.category === 'general-cache')).toBe(true)
        expect(excluded).toContain('npm-cache')
        expect(excluded).toContain('codex-releases')
        expect(excluded).toContain('slack')
    })

    test('keeps saved selections that map to general cache cleanup', () => {
        const { cleaners, excluded } = resolveSignInCleaners(catalog, ['vscode', 'codex', 'opencode', 'unknown-app'])
        expect(cleaners.map((cleaner) => cleaner.id)).toEqual(['vscode', 'codex'])
        expect(excluded).toEqual(['opencode', 'unknown-app'])
    })

    test('does not repurpose saved old-version selections as cache cleanup', () => {
        // Before cache cleaners existed, these IDs only removed old Squirrel versions.
        const { cleaners, excluded } = resolveSignInCleaners(catalog, ['discord', 'github-desktop'])
        expect(cleaners).toEqual([])
        expect(excluded).toEqual(['discord', 'github-desktop'])
    })
})

describe('unattended category selection', () => {
    test('selects only cleaners in the named categories', () => {
        const general = cleanersForCategories(catalog, ['general-cache'])
        expect(general.map((cleaner) => cleaner.id)).toContain('codex')
        expect(general.some((cleaner) => cleaner.category !== 'general-cache')).toBe(false)

        const destructive = cleanersForCategories(catalog, ['destructive-cache'])
        expect(destructive.map((cleaner) => cleaner.id)).toContain('npm-cache')
        expect(destructive.some((cleaner) => cleaner.category !== 'destructive-cache')).toBe(false)
    })
})

describe('cleaner catalog', () => {
    test('gives every cleaner a unique ID', () => {
        const ids = catalog.map((cleaner) => cleaner.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test('splits apps with caches and old installations into separate cleaners', () => {
        for (const appId of ['codex', 'claude-code', 'discord', 'github-desktop']) {
            const categories = catalog
                .filter((cleaner) => cleaner.appId === appId)
                .map((cleaner) => cleaner.category)
                .toSorted()
            expect(categories).toEqual(['general-cache', 'old-installations'])
        }
    })
})

describe('Windows temporary directories category', () => {
    test('selects only the per-user temporary cleaners when named', () => {
        const temporary = cleanersForCategories(catalog, ['windows-temp'])
        expect(temporary.map((cleaner) => cleaner.id)).toEqual(['user-temp', 'internet-cache'])
    })

    test('is never run by sign-in cleanup, even when saved', () => {
        const { cleaners, excluded } = resolveSignInCleaners(catalog, ['user-temp', 'internet-cache', 'codex'])
        expect(cleaners.map((cleaner) => cleaner.id)).toEqual(['codex'])
        expect(excluded).toEqual(['user-temp', 'internet-cache'])
    })

    test('follows destructive cache cleanup in the cache operation', () => {
        expect(categoriesForOperation('caches').map((category) => category.id)).toEqual(['general-cache', 'destructive-cache', 'windows-temp'])
    })
})
