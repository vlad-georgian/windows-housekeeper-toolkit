import { join, resolve } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import { runPowerShell } from "../powershell.ts";
import { isAppRunning, listWindowsProcesses } from "../processes.ts";
import { isLocalPath, samePath } from "./files.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function assertCodexClosed(): Promise<void> {
    const processes = await listWindowsProcesses();
    // The Windows sandbox service has its own diagnostics and does not own the Codex app log DB.
    const appProcesses = processes.filter(
        (entry) => !/^codex-windows-sandbox-service(?:\.exe)?$/i.test(entry.name),
    );
    if (isAppRunning("codex", appProcesses)) {
        throw new Error(
            "Close Codex and ChatGPT, including the Codex app-server daemon, then retry.",
        );
    }
}

export async function verifyCodexEnvironment(paths: SystemPaths, home: string): Promise<void> {
    const persisted: unknown = JSON.parse(
        await runPowerShell(`
    $values = @{}
    foreach ($name in @('CODEX_HOME', 'CODEX_SQLITE_HOME')) {
      $values[$name] = @([Environment]::GetEnvironmentVariable($name, 'User'),
                          [Environment]::GetEnvironmentVariable($name, 'Machine'))
    }
    ConvertTo-Json -InputObject $values -Compress
  `),
    );
    if (
        !isRecord(persisted) ||
        !Array.isArray(persisted.CODEX_HOME) ||
        !Array.isArray(persisted.CODEX_SQLITE_HOME)
    ) {
        throw new Error("Windows could not verify the Codex environment settings.");
    }
    const homes: unknown[] = persisted.CODEX_HOME;
    const sqliteHomes: unknown[] = persisted.CODEX_SQLITE_HOME;
    if (
        [process.env.CODEX_HOME, ...homes].some(
            (value) =>
                value &&
                (typeof value !== "string" || !isLocalPath(value) || !samePath(value, home)),
        ) ||
        [process.env.CODEX_SQLITE_HOME, ...sqliteHomes].some(Boolean)
    ) {
        throw new Error(
            "A custom CODEX_HOME or CODEX_SQLITE_HOME makes the active log location ambiguous.",
        );
    }

    const standalone = Bun.which("codex.exe");
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    const triple = process.arch === "arm64" ? "aarch64" : "x86_64";
    const npmBinary = join(
        paths.home,
        "scoop",
        "apps",
        "nodejs",
        "current",
        "bin",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        `codex-win32-${architecture}`,
        "vendor",
        `${triple}-pc-windows-msvc`,
        "bin",
        "codex.exe",
    );
    const executable = standalone ?? ((await Bun.file(npmBinary).exists()) ? npmBinary : null);
    if (!executable)
        throw new Error("Could not find an installed Codex executable to verify the redirect.");
    const command = Bun.spawn([executable, "app-server", "--print-startup-config"], {
        cwd: resolve(paths.home),
        env: { ...process.env, CODEX_HOME: home },
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
        signal: AbortSignal.timeout(20_000),
    });
    const [stdout, exit] = await Promise.all([new Response(command.stdout).text(), command.exited]);
    if (exit !== 0) throw new Error("Codex could not validate its startup configuration.");
    const report: unknown = JSON.parse(stdout);
    const version =
        isRecord(report) &&
        typeof report.appServerVersion === "string" &&
        report.appServerVersion.match(/^0\.(\d+)\.\d+(?:[-+].*)?$/);
    if (
        !version ||
        Number(version[1]) < 167 ||
        !isRecord(report) ||
        !isRecord(report.configRequirements) ||
        !Object.hasOwn(report.configRequirements, "requirements")
    ) {
        throw new Error(
            "The installed Codex build could not verify support for the diagnostic log redirect.",
        );
    }
    const requirements = report.configRequirements.requirements;
    if (
        requirements !== null &&
        (!isRecord(requirements) ||
            requirements.logDir ||
            requirements.sqliteHome ||
            requirements.log_dir ||
            requirements.sqlite_home)
    ) {
        throw new Error("Managed Codex requirements control the log or SQLite directory.");
    }
}
