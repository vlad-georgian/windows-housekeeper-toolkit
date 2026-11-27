import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "../../test-support/fixtures.ts";
import { ChocolateyCacheCleaner } from "./chocolatey-cleaner.ts";

let sandbox: Sandbox;
const install = join("ProgramData", "chocolatey");

function config(cacheLocation: string): string {
    return `<?xml version="1.0"?>\n<chocolatey>\n  <config>\n    <add key="cacheLocation" value="${cacheLocation}" description="Cache location if not TEMP folder." />\n  </config>\n</chocolatey>\n`;
}

beforeEach(async () => {
    sandbox = await createSandbox();
    await sandbox.file(join(install, "choco.exe"));
    await sandbox.file(
        join(
            "Users",
            "test",
            "AppData",
            "Local",
            "Temp",
            "chocolatey",
            "git",
            "2.50.0",
            "Git-64-bit.exe",
        ),
    );
    await sandbox.file(
        join("Users", "test", "AppData", "Local", "Temp", "chocolatey", "7zip.24.09.nupkg"),
    );
});
afterEach(() => sandbox.dispose());

function cleaner(): ChocolateyCacheCleaner {
    return new ChocolateyCacheCleaner(sandbox.paths, {
        ChocolateyInstall: join(sandbox.root, install),
    });
}

describe("Chocolatey download cache", () => {
    test("offers the per-user download cache when Chocolatey uses its default location", async () => {
        await sandbox.file(join(install, "config", "chocolatey.config"), config(""));
        const candidates = await cleaner().detect();
        expect(candidates.map((candidate) => candidate.displayName).toSorted()).toEqual([
            "Chocolatey cached 7zip.24.09.nupkg",
            "Chocolatey cached git",
        ]);
    });

    test("offers nothing when the cache location is customised", async () => {
        await sandbox.file(
            join(install, "config", "chocolatey.config"),
            config(String.raw`D:\choco-cache`),
        );
        expect(await cleaner().detect()).toEqual([]);
    });

    test("offers nothing without a verified Chocolatey installation", async () => {
        expect(await new ChocolateyCacheCleaner(sandbox.paths, {}).detect()).toEqual([]);
    });
});
