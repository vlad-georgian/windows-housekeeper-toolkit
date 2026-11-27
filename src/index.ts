#!/usr/bin/env bun

import * as p from "@clack/prompts";

import { createCleaners } from "./cleaners/index.ts";
import { runManualCleanup } from "./cleanup/manual.ts";
import { runAtSignIn } from "./cleanup/signin.ts";
import { errorMessage } from "./core/format.ts";
import { projectName, withRunLock } from "./core/state.ts";
import { getSystemPaths } from "./core/system-paths.ts";
import { runAppControls } from "./windows/app-controls.ts";
import { runMigration } from "./windows/migration/index.ts";
import { openNotificationLog } from "./windows/notification.ts";
import { runSignInSettings } from "./windows/signin.ts";

async function main(): Promise<void> {
    if (process.platform !== "win32") throw new Error(`${projectName} supports Windows only.`);
    const paths = getSystemPaths();
    const cleaners = createCleaners(paths);
    const args = Bun.argv.slice(2);
    const [command, ...rest] = args;
    switch (command) {
        case "startup":
        case "updates":
            await withRunLock(paths, () => runAppControls(args));
            return;
        case "migration":
            await withRunLock(paths, () => runMigration(paths, rest));
            return;
        case "signin":
            if (rest.length === 1 && rest[0] === "run") {
                await runAtSignIn(paths, cleaners);
            } else {
                await withRunLock(paths, () => runSignInSettings(paths, cleaners, rest));
            }
            return;
        case "notification-log":
            await openNotificationLog(paths, rest);
            return;
        default:
            await runManualCleanup(paths, cleaners, args);
    }
}

main().catch((error: unknown) => {
    p.log.error(errorMessage(error));
    process.exitCode = 1;
});
