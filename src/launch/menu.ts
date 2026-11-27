import { cancelled, type LaunchOperation, type LaunchPrompts, type PlanSection } from "./types.ts";

export type LaunchOutcome = "nothing-selected" | "cancelled" | "declined" | "applied" | "previewed";

/**
 * Runs the launch menu: every operation starts unchecked, each selected operation gathers its
 * choices, and one combined plan is confirmed before anything is applied. Cancelling any prompt
 * leaves the whole plan unapplied. A dry run previews the plan without asking for confirmation.
 */
export async function runLaunchMenu(
    operations: readonly LaunchOperation[],
    prompts: LaunchPrompts,
    { dryRun }: { readonly dryRun: boolean },
): Promise<LaunchOutcome> {
    const chosen = await prompts.checklist({
        message: "What would you like to do? Press Space to select, A to toggle all.",
        options: operations.map((operation) => ({
            value: operation.id,
            label: operation.label,
            ...(operation.hint === undefined ? {} : { hint: operation.hint }),
        })),
        initialValues: [],
    });
    if (chosen === null) return "cancelled";

    const selected = new Set(chosen);
    const sections: PlanSection[] = [];
    for (const operation of operations) {
        if (!selected.has(operation.id)) continue;
        const section = await operation.gather(prompts);
        if (section === cancelled) return "cancelled";
        if (section) sections.push(section);
    }
    if (sections.length === 0) return "nothing-selected";

    prompts.note(
        dryRun ? "Plan (dry run)" : "Plan",
        sections.flatMap((section) => [section.title, ...section.lines.map((line) => `  ${line}`)]),
    );
    if (!dryRun) {
        const confirmed = await prompts.confirm("Apply this plan?");
        if (confirmed === null) return "cancelled";
        if (!confirmed) return "declined";
    }
    for (const section of sections) await section.apply();
    return dryRun ? "previewed" : "applied";
}
