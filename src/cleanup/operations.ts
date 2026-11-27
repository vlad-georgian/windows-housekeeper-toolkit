import type { AuditLogger } from "../core/audit-logger.ts";
import type { AppCleaner, DetectionResult } from "../core/types.ts";
import {
    cancelled,
    type LaunchOperation,
    type LaunchPrompts,
    type PlanSection,
} from "../launch/types.ts";
import {
    categoriesForOperation,
    cleanersForCategories,
    type CleanupOperationId,
} from "./categories.ts";
import { runCleanup } from "./remove.ts";
import { deduplicate, optionHint, scan } from "./scan.ts";
import type { CleanupSummary } from "./summary.ts";

/** State shared by every cleanup operation in one run, interactive or unattended. */
export interface CleanupSession {
    readonly audit: AuditLogger;
    readonly summary: CleanupSummary;
    readonly dryRun: boolean;
    /** Cleaner IDs whose targets were applied or previewed, for the audit summary. */
    readonly selectedCleaners: Set<string>;
}

function describeResult(result: DetectionResult): string {
    const implications = result.cleaner.implications ? `. ${result.cleaner.implications}` : "";
    return `${optionHint(result)}${implications}`;
}

/** Removes, or previews in a dry run, every candidate of the given detections. */
export async function applyCleanup(
    selections: readonly DetectionResult[],
    session: CleanupSession,
): Promise<void> {
    for (const result of selections) session.selectedCleaners.add(result.cleaner.id);
    await runCleanup(deduplicate(selections), session.audit, session.summary, {
        dryRun: session.dryRun,
        signIn: false,
    });
}

/** Scans the cleaners and applies all candidates of the named categories without prompts. */
export async function runUnattendedCleanup(
    cleaners: readonly AppCleaner[],
    session: CleanupSession,
): Promise<void> {
    const results = await scan(cleaners, session.audit, session.summary, false);
    await applyCleanup(
        results.filter((result) => result.candidates.length > 0),
        session,
    );
}

function createCleanupOperation(
    id: CleanupOperationId,
    label: string,
    cleaners: readonly AppCleaner[],
    session: CleanupSession,
): LaunchOperation {
    const categories = categoriesForOperation(id);
    return {
        id,
        label,
        async gather(prompts: LaunchPrompts): Promise<PlanSection | null | typeof cancelled> {
            const inScope = cleanersForCategories(
                cleaners,
                categories.map((category) => category.id),
            );
            prompts.log(`Scanning ${inScope.length} cleaners for ${label.toLowerCase()}…`);
            const results = await scan(inScope, session.audit, session.summary, false);

            const selections: DetectionResult[] = [];
            const lines: string[] = [];
            for (const category of categories) {
                const available = results.filter(
                    (result) =>
                        result.cleaner.category === category.id && result.candidates.length > 0,
                );
                if (available.length === 0) {
                    prompts.log(`${category.label}: nothing removable detected.`);
                    continue;
                }
                const answer = await prompts.checklist({
                    message: `${category.checklistMessage} Press A to toggle all.`,
                    options: available.map((result) => ({
                        value: result.cleaner.id,
                        label: result.cleaner.label,
                        hint: describeResult(result),
                    })),
                    initialValues: [],
                });
                if (answer === null) return cancelled;
                const chosen = available.filter((result) => answer.includes(result.cleaner.id));
                if (chosen.length === 0) continue;
                selections.push(...chosen);
                lines.push(
                    category.label,
                    ...chosen.map(
                        (result) => `  ${result.cleaner.label}: ${describeResult(result)}`,
                    ),
                );
            }
            if (selections.length === 0) return null;
            return { title: label, lines, apply: () => applyCleanup(selections, session) };
        },
    };
}

/** Cleanup operations for the launch menu, in menu order. */
export function createCleanupOperations(
    cleaners: readonly AppCleaner[],
    session: CleanupSession,
): LaunchOperation[] {
    return [
        createCleanupOperation("caches", "Remove caches", cleaners, session),
        createCleanupOperation(
            "old-installations",
            "Remove old data and installations",
            cleaners,
            session,
        ),
    ];
}
