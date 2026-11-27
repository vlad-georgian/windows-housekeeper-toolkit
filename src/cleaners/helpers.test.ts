import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "../test-support/fixtures.ts";
import { detectUpdaterDirectory } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(async () => {
    sandbox = await createSandbox();
});
afterEach(() => sandbox.dispose());

describe("updater download detection", () => {
    test("offers installed-update payloads and preserves pending updates", async () => {
        const updater = join("Users", "test", "AppData", "Local", "app-updater");
        await sandbox.file(join(updater, "installer.exe"));
        await sandbox.file(join(updater, "installer.exe.blockmap"));
        await sandbox.file(join(updater, "pending", "app-setup-2.0.0.exe"));
        await sandbox.file(join(updater, "settings.json"));

        const candidates = await detectUpdaterDirectory({
            appId: "app",
            updaterRoot: join(sandbox.root, updater),
            allowedRoot: sandbox.paths.localAppData,
            label: "App",
        });
        expect(candidates.map((candidate) => candidate.displayName).toSorted()).toEqual([
            "App downloaded installer.exe",
            "App downloaded installer.exe.blockmap",
        ]);
    });
});
