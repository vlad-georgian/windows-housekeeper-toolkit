import { resolve } from "node:path";

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map, optional } from "@optique/core/modifiers";
import { option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { run } from "@optique/run";

import { projectName } from "./state.ts";

export interface CliOptions {
    readonly all: boolean;
    readonly appId: string | null;
    readonly dryRun: boolean;
    readonly logDirectory: string;
}

const targetParser = optional(
    or(
        map(
            option("--all", {
                description: message`Select every supported application.`,
            }),
            () => ({ kind: "all" as const }),
        ),
        map(
            option("--app", string({ metavar: "ID" }), {
                description: message`Select one application by its cleaner ID.`,
            }),
            (appId) => ({ kind: "app" as const, appId }),
        ),
    ),
);

const cliParser = map(
    object({
        target: targetParser,
        dryRun: option("--dry-run", {
            description: message`Detect and log targets without removing them.`,
        }),
        logDirectory: optional(
            option("--log-dir", string({ metavar: "PATH" }), {
                description: message`Write audit logs somewhere other than ./logs.`,
            }),
        ),
    }),
    (options): CliOptions => ({
        all: options.target?.kind === "all",
        appId: options.target?.kind === "app" ? options.target.appId : null,
        dryRun: options.dryRun,
        logDirectory: resolve(options.logDirectory ?? resolve(process.cwd(), "logs")),
    }),
);

export function parseCliOptions(arguments_: readonly string[]): CliOptions {
    return run(cliParser, {
        programName: projectName,
        args: arguments_,
        help: "both",
        version: "0.1.0",
        completion: "both",
        brief: message`Safely remove redundant Windows application payloads.`,
        description: message`Run without a target option to choose applications interactively. For Windows controls, see startup --help, updates --help, signin --help, and migration --help.`,
        showUsage: true,
    });
}
