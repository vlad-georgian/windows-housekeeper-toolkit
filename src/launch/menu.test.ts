import { describe, expect, test } from "bun:test";

import { FakePrompts } from "../test-support/fake-prompts.ts";
import { runLaunchMenu } from "./menu.ts";
import { cancelled, type LaunchOperation } from "./types.ts";

function fakeOperation(
    id: string,
    gather: LaunchOperation["gather"] = async () => ({
        title: `Plan ${id}`,
        lines: [`${id} line`],
        apply: async () => {
            applied.push(id);
        },
    }),
): LaunchOperation {
    return { id, label: `Operation ${id}`, gather };
}

let applied: string[] = [];

describe("launch menu", () => {
    test("starts with every operation unchecked and offers A to toggle all", async () => {
        applied = [];
        const prompts = new FakePrompts([[]]);
        const outcome = await runLaunchMenu([fakeOperation("a"), fakeOperation("b")], prompts, {
            dryRun: false,
        });
        expect(outcome).toBe("nothing-selected");
        expect(prompts.checklists[0]?.initialValues).toEqual([]);
        expect(prompts.checklists[0]?.options.map((option) => option.value)).toEqual(["a", "b"]);
        expect(prompts.checklists[0]?.message).toContain("A to toggle all");
    });

    test("gathers every selection before showing one combined plan, then applies it", async () => {
        applied = [];
        const order: string[] = [];
        const tracked = (id: string): LaunchOperation =>
            fakeOperation(id, async () => {
                order.push(`gather ${id}`);
                return {
                    title: `Plan ${id}`,
                    lines: [`${id} line`],
                    apply: async () => {
                        order.push(`apply ${id}`);
                    },
                };
            });
        const prompts = new FakePrompts([["a", "b"], true]);
        const outcome = await runLaunchMenu([tracked("a"), tracked("b")], prompts, {
            dryRun: false,
        });
        expect(outcome).toBe("applied");
        expect(order).toEqual(["gather a", "gather b", "apply a", "apply b"]);
        expect(prompts.notes).toHaveLength(1);
        expect(prompts.notes[0]?.lines).toEqual(["Plan a", "  a line", "Plan b", "  b line"]);
        expect(prompts.confirmations).toHaveLength(1);
    });

    test("cancelling the launch menu leaves the plan unapplied", async () => {
        applied = [];
        const prompts = new FakePrompts([null]);
        const outcome = await runLaunchMenu([fakeOperation("a")], prompts, { dryRun: false });
        expect(outcome).toBe("cancelled");
        expect(applied).toEqual([]);
    });

    test("cancelling a later operation's prompt leaves earlier selections unapplied", async () => {
        applied = [];
        const prompts = new FakePrompts([["a", "b"]]);
        const outcome = await runLaunchMenu(
            [fakeOperation("a"), fakeOperation("b", async () => cancelled)],
            prompts,
            { dryRun: false },
        );
        expect(outcome).toBe("cancelled");
        expect(applied).toEqual([]);
        expect(prompts.notes).toEqual([]);
    });

    test("cancelling or declining the confirmation leaves the plan unapplied", async () => {
        for (const answer of [false, null]) {
            applied = [];
            const prompts = new FakePrompts([["a"], answer]);
            const outcome = await runLaunchMenu([fakeOperation("a")], prompts, { dryRun: false });
            expect(outcome).toBe(answer === null ? "cancelled" : "declined");
            expect(applied).toEqual([]);
        }
    });

    test("a dry run previews the plan without asking for confirmation", async () => {
        applied = [];
        const prompts = new FakePrompts([["a"]]);
        const outcome = await runLaunchMenu([fakeOperation("a")], prompts, { dryRun: true });
        expect(outcome).toBe("previewed");
        expect(prompts.confirmations).toEqual([]);
        expect(applied).toEqual(["a"]);
    });

    test("selected operations with nothing to do produce no plan", async () => {
        applied = [];
        const prompts = new FakePrompts([["a"]]);
        const outcome = await runLaunchMenu([fakeOperation("a", async () => null)], prompts, {
            dryRun: false,
        });
        expect(outcome).toBe("nothing-selected");
        expect(prompts.confirmations).toEqual([]);
    });
});
