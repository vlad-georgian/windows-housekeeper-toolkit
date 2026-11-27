import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createCleaners } from "../cleaners/index.ts";
import { AuditLogger } from "../core/audit-logger.ts";
import { pathExists } from "../core/filesystem/index.ts";
import type { CleanupCategoryId } from "../core/types.ts";
import { createSandbox, type Sandbox } from "../test-support/fixtures.ts";
import { cleanersForCategories } from "./categories.ts";
import { type CleanupSession, runUnattendedCleanup } from "./operations.ts";
import { newSummary } from "./summary.ts";

// Overrides that would point cleaners at real locations instead of the sandbox.
const overrides = [
    "CODEX_HOME",
    "SCOOP",
    "SCOOP_CACHE",
    "BUN_INSTALL",
    "BUN_INSTALL_CACHE_DIR",
    "ChocolateyInstall",
];
const saved = new Map(overrides.map((name) => [name, process.env[name]]));
beforeAll(() => {
    for (const name of overrides) delete process.env[name];
});
afterAll(() => {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
});

// These cleaners query live Windows state (Driver Store, running processes). Their selection
// rules are covered by fixture tests of their own.
const liveSystemCleaners = new Set(["nvidia-drivers", "codex-releases"]);

let sandbox: Sandbox;
const home = join("Users", "test");
const local = join(home, "AppData", "Local");

beforeEach(async () => {
    sandbox = await createSandbox();
});
afterEach(() => sandbox.dispose());

async function dryRun(category: CleanupCategoryId): Promise<{
    session: CleanupSession;
    removedTargets: string[];
    log: string;
}> {
    const cleaners = cleanersForCategories(createCleaners(sandbox.paths), [category]).filter(
        (cleaner) => !liveSystemCleaners.has(cleaner.id),
    );
    const session: CleanupSession = {
        audit: await AuditLogger.create(join(sandbox.root, "logs")),
        summary: newSummary(),
        dryRun: true,
        selectedCleaners: new Set(),
    };
    await runUnattendedCleanup(cleaners, session);
    const log = await readFile(session.audit.path, "utf8");
    return { session, removedTargets: log.match(/"entry-removed"/g) ?? [], log };
}

describe("dry run per cleanup category", () => {
    test("general cache cleanup previews regenerable caches without removing them", async () => {
        const codex = await sandbox.file(
            join(home, ".codex", "cache", "codex_apps_tools", "t.json"),
        );
        const discord = await sandbox.file(
            join(home, "AppData", "Roaming", "discord", "Cache", "data_0"),
        );
        const { session, removedTargets, log } = await dryRun("general-cache");
        expect([...session.selectedCleaners].toSorted()).toEqual(["codex", "discord"]);
        expect(session.summary.detectedBytes).toBe(2);
        expect(removedTargets).toEqual([]);
        expect(log).toContain('"dry-run-skip"');
        expect(await pathExists(codex)).toBe(true);
        expect(await pathExists(discord)).toBe(true);
    });

    test("destructive cache cleanup previews package caches without removing them", async () => {
        const npm = await sandbox.file(join(local, "npm-cache", "_cacache", "index-v5", "00"));
        const npx = await sandbox.file(join(local, "npm-cache", "_npx", "abc", "package.json"));
        await sandbox.file(join(home, "scoop", "apps", "scoop", "current", "scoop.ps1"));
        const scoop = await sandbox.file(join(home, "scoop", "cache", "git#2.50.0#abc1234.7z"));
        const { session, removedTargets } = await dryRun("destructive-cache");
        expect([...session.selectedCleaners].toSorted()).toEqual(["npm-cache", "scoop-cache"]);
        expect(removedTargets).toEqual([]);
        for (const path of [npm, npx, scoop]) expect(await pathExists(path)).toBe(true);
    });

    test("old-installation cleanup previews superseded releases without removing them", async () => {
        const app = join(local, "GitHubDesktop");
        await sandbox.file(join(app, "Update.exe"));
        await sandbox.file(
            join(app, "packages", "RELEASES"),
            `${"a".repeat(40)} GitHubDesktop-3.4.0-full.nupkg 1234\n`,
        );
        for (const version of ["3.4.0", "3.3.0"]) {
            await sandbox.file(join(app, `app-${version}`, "GitHubDesktop.exe"));
        }
        const superseded = await sandbox.file(join(app, "app-3.2.0", "GitHubDesktop.exe"));
        const { session, removedTargets, log } = await dryRun("old-installations");
        expect([...session.selectedCleaners]).toEqual(["github-desktop-versions"]);
        expect(log).toContain("GitHub Desktop 3.2.0");
        expect(log).not.toContain("GitHub Desktop 3.3.0");
        expect(removedTargets).toEqual([]);
        expect(await pathExists(superseded)).toBe(true);
    });
});
