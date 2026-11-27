import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "../../test-support/fixtures.ts";
import { canRemoveRelease, inspectReleaseStore } from "./codex-release-store.ts";

const target = "x86_64-pc-windows-msvc";
let sandbox: Sandbox;
let codexHome: string;

beforeEach(async () => {
    sandbox = await createSandbox();
    codexHome = join(sandbox.paths.home, ".codex");
});
afterEach(() => sandbox.dispose());

function storePath(store: string, ...parts: string[]): string {
    return join("Users", "test", ".codex", "packages", store, ...parts);
}

async function addRelease(store: string, version: string, manifest?: object): Promise<string> {
    const name = `${version}-${target}`;
    await sandbox.file(
        storePath(store, "releases", name, "codex-package.json"),
        JSON.stringify(
            manifest ?? {
                layoutVersion: 1,
                version,
                target,
                variant: store === "standalone" ? "codex" : "codex-app-server",
                entrypoint: "bin/codex.exe",
            },
        ),
    );
    await sandbox.file(storePath(store, "releases", name, "bin", "codex.exe"));
    return name;
}

async function select(store: string, version: string): Promise<void> {
    await symlink(
        join(sandbox.root, storePath(store, "releases", `${version}-${target}`)),
        join(sandbox.root, storePath(store, "current")),
        "junction",
    );
}

async function removable(store: string, names: readonly string[]): Promise<string[]> {
    const inspected = await inspectReleaseStore(codexHome, store);
    if (!inspected) return [];
    const result: string[] = [];
    for (const name of names) if (await canRemoveRelease(inspected, name)) result.push(name);
    return result;
}

describe("Codex release store", () => {
    test("keeps only the selected release; the recorded rollback release qualifies", async () => {
        const older = await addRelease("standalone", "0.160.0");
        const previous = await addRelease("standalone", "0.165.0");
        const active = await addRelease("standalone", "0.167.0");
        await select("standalone", "0.167.0");
        await sandbox.file(
            storePath("standalone", "selection-history"),
            `${active}\n${previous}\n`,
        );
        await sandbox.file(storePath("standalone", "auto-update-version"), active);

        expect(await removable("standalone", [older, previous, active])).toEqual([older, previous]);
    });

    test("preserves a staged newer release while cleaning older ones", async () => {
        const older = await addRelease("standalone", "0.160.0");
        const active = await addRelease("standalone", "0.167.0");
        const staged = await addRelease("standalone", "0.170.0");
        await select("standalone", "0.167.0");
        await sandbox.file(storePath("standalone", "auto-update-version"), staged);

        expect(await removable("standalone", [older, active, staged])).toEqual([older]);
    });

    test("skips a store whose staged update marker cannot be verified", async () => {
        const older = await addRelease("standalone", "0.160.0");
        await addRelease("standalone", "0.167.0");
        await select("standalone", "0.167.0");
        await sandbox.file(storePath("standalone", "auto-update-version"), "not-a-release");

        expect(await removable("standalone", [older])).toEqual([]);
    });

    test("skips releases whose package manifest does not verify", async () => {
        const unverified = await addRelease("standalone", "0.150.0", { layoutVersion: 2 });
        await addRelease("standalone", "0.167.0");
        await select("standalone", "0.167.0");

        expect(await removable("standalone", [unverified])).toEqual([]);
    });

    test("decides each release store independently", async () => {
        const daemonOld = await addRelease("app-server-daemon", "0.169.1");
        await addRelease("app-server-daemon", "0.172.0");
        await select("app-server-daemon", "0.172.0");
        const standaloneOld = await addRelease("standalone", "0.160.0");
        await addRelease("standalone", "0.167.0");
        await select("standalone", "0.167.0");
        await sandbox.file(storePath("standalone", ".migration-current"));

        expect(await removable("app-server-daemon", [daemonOld])).toEqual([daemonOld]);
        expect(await removable("standalone", [standaloneOld])).toEqual([]);
    });
});
