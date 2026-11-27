import { symlink } from "node:fs/promises";
import { join } from "node:path";

import type { Sandbox } from "./fixtures.ts";

const target = "x86_64-pc-windows-msvc";

/** Sandbox-relative path inside a Codex release store such as `standalone`. */
export function codexStorePath(store: string, ...parts: string[]): string {
    return join("Users", "test", ".codex", "packages", store, ...parts);
}

/** Adds a release directory with a package manifest and binary. Returns the release name. */
export async function addCodexRelease(
    sandbox: Sandbox,
    store: string,
    version: string,
    manifest?: object,
): Promise<string> {
    const name = `${version}-${target}`;
    await sandbox.file(
        codexStorePath(store, "releases", name, "codex-package.json"),
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
    await sandbox.file(codexStorePath(store, "releases", name, "bin", "codex.exe"));
    return name;
}

/** Points the store's `current` junction at a release, as the Codex installer does. */
export async function selectCodexRelease(
    sandbox: Sandbox,
    store: string,
    version: string,
): Promise<void> {
    await symlink(
        join(sandbox.root, codexStorePath(store, "releases", `${version}-${target}`)),
        join(sandbox.root, codexStorePath(store, "current")),
        "junction",
    );
}
