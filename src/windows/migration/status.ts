import { realpath, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";

import { formatBytes } from "../../core/format.ts";
import type { SystemPaths } from "../../core/system-paths.ts";
import { codexConfiguration, codexLogDocumentation } from "./codex-config.ts";
import { logNames, plainFile, samePath, statsIfPresent } from "./files.ts";
import type { Migration } from "./journal.ts";
import { sourcePath } from "./snapshot.ts";

async function reportPath(label: string, path: string, detail: string): Promise<void> {
    try {
        if (!(await statsIfPresent(path))) return;
        const resolved = await realpath(path);
        console.log(
            `${label} | ${path}${samePath(path, resolved) ? "" : ` → ${resolved}`} | ${detail}`,
        );
    } catch {
        console.log(`${label} | ${path} | Windows did not resolve this location.`);
    }
}

export async function showStatus(paths: SystemPaths, operation: Migration | null): Promise<void> {
    const home = join(paths.home, ".codex");
    const effectiveHome = process.env.CODEX_HOME;
    try {
        const config = await codexConfiguration(join(home, "config.toml"));
        const logDir = config.settings.log_dir;
        const sqliteHome = config.settings.sqlite_home ?? process.env.CODEX_SQLITE_HOME;
        const redirect = typeof logDir === "string" ? logDir : sqliteHome;
        if (effectiveHome && !samePath(home, effectiveHome)) {
            console.log(
                `Codex | CODEX_HOME = ${effectiveHome} | Custom profile. The diagnostic source needs verification.`,
            );
        } else if (typeof redirect === "string") {
            const location = resolve(home, redirect);
            console.log(
                `Codex diagnostic logs | ${location} | Existing ${typeof logDir === "string" ? "log_dir" : "SQLite"} redirect.`,
            );
            await reportPath("Resolved Codex redirect", location, "Current configured directory.");
        } else {
            let size = 0;
            for (const name of logNames)
                size += Number((await plainFile(sourcePath(home, name)))?.size ?? 0);
            console.log(
                `Codex diagnostic logs (codex-logs) | ${home} | ${size > 0 ? `${formatBytes(size)} available for verification after Codex closes` : "No diagnostic log files found"}.`,
            );
            console.log(`Codex log_dir documentation | ${codexLogDocumentation}`);
        }
    } catch (error) {
        console.log(
            `Codex | ${home} | ${error instanceof Error ? error.message : "The diagnostic source needs verification."}`,
        );
        await reportPath("Codex profile", home, "This location is report-only.");
    }
    if (operation) console.log(`Codex migration | ${operation.phase} | ${operation.destination}`);

    await reportPath(
        "Claude Desktop package data",
        join(paths.localAppData, "Packages", "Claude_pzs8sxrjxfjjc"),
        "Package data is protected.",
    );
    await reportPath(
        "Claude Code cache",
        join(paths.home, ".claude", "cache"),
        "A cache-only redirect is unverified.",
    );
    await reportPath(
        "T3 Code data",
        join(paths.home, ".t3"),
        "Worktrees and profile data are protected.",
    );
    await reportPath(
        "OpenCode cache",
        join(process.env.XDG_CACHE_HOME ?? join(paths.home, ".cache"), "opencode"),
        "A persistent app-specific cache redirect is unverified.",
    );
    await reportPath(
        "OpenCode logs",
        join(process.env.XDG_DATA_HOME ?? join(paths.home, ".local", "share"), "opencode", "log"),
        "The XDG data root also controls protected state.",
    );
    try {
        const volume = await statfs("E:\\", { bigint: true });
        console.log(`E:\\ | ${formatBytes(Number(volume.bavail * volume.bsize))} available.`);
    } catch {
        // E: is a suggested destination on hosts where it is present.
    }
}
