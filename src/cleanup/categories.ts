import type { AppCleaner, CleanupCategoryId } from '../core/types.ts'
import { hasProcessGuard } from '../windows/processes.ts'

/** The launch-menu operation that owns a cleanup category's checklist. */
export type CleanupOperationId = 'caches' | 'old-installations'

export interface CleanupCategory {
    readonly id: CleanupCategoryId
    readonly operation: CleanupOperationId
    /** Glossary name shown as the plan heading. */
    readonly label: string
    readonly checklistMessage: string
    /** Whether the unattended sign-in job may run this category. */
    readonly signIn: boolean
}

/** Cleanup categories in checklist order. Every checklist item starts unchecked. */
export const cleanupCategories: readonly CleanupCategory[] = [
    {
        id: 'general-cache',
        operation: 'caches',
        label: 'General cache cleanup',
        checklistMessage: 'Which regenerable app caches should be removed?',
        signIn: true
    },
    {
        id: 'destructive-cache',
        operation: 'caches',
        label: 'Destructive cache cleanup',
        checklistMessage: 'Which package download caches should be removed? They can cause redownloads and affect offline use.',
        signIn: false
    },
    {
        id: 'old-installations',
        operation: 'old-installations',
        label: 'Old data and installations',
        checklistMessage: "Which apps' superseded installations and old data should be removed?",
        signIn: false
    }
]

export function cleanupCategory(id: CleanupCategoryId): CleanupCategory {
    const category = cleanupCategories.find((entry) => entry.id === id)
    if (!category) throw new Error(`Unknown cleanup category "${id}".`)
    return category
}

export function categoriesForOperation(operation: CleanupOperationId): CleanupCategory[] {
    return cleanupCategories.filter((category) => category.operation === operation)
}

/** Cleaners for an unattended run. Only the named categories are included. */
export function cleanersForCategories(cleaners: readonly AppCleaner[], categories: readonly CleanupCategoryId[]): AppCleaner[] {
    const named = new Set(categories)
    return cleaners.filter((cleaner) => named.has(cleaner.category))
}

function isSignInEligible(cleaner: AppCleaner): boolean {
    return cleanupCategory(cleaner.category).signIn && hasProcessGuard(cleaner.appId)
}

/**
 * Maps saved sign-in selections onto the cleaners the sign-in job may run. Selections that
 * name another category or an unknown cleaner are excluded rather than rejected, so an enabled
 * sign-in job keeps its general cache selections.
 */
export function resolveSignInCleaners(cleaners: readonly AppCleaner[], ids: readonly string[]): { cleaners: AppCleaner[]; excluded: string[] } {
    const byId = new Map(cleaners.map((cleaner) => [cleaner.id, cleaner]))
    const selected: AppCleaner[] = []
    const excluded: string[] = []
    for (const id of new Set(ids)) {
        const cleaner = byId.get(id)
        if (cleaner && isSignInEligible(cleaner)) selected.push(cleaner)
        else excluded.push(id)
    }
    return { cleaners: selected, excluded }
}

export function signInEligibleIds(cleaners: readonly AppCleaner[]): string[] {
    return cleaners.filter(isSignInEligible).map((cleaner) => cleaner.id)
}
