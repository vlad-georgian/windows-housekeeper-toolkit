import type { SystemPaths } from "../../core/system-paths.ts";
import {
    type AppId,
    appIds,
    appNames,
    getAppInventory,
    isArrayOf,
    isString,
    parseInventoryResult,
    scheduledTaskScript,
} from "../app-catalog.ts";
import { runPowerShell } from "../powershell.ts";
import { disablePackageBackgroundUpdates, getAppInstallerStatus } from "./app-installer.ts";

async function getUpdaterTaskStatus(app?: AppId): Promise<string[]> {
    try {
        const output = await runPowerShell(
            String.raw`
    ${scheduledTaskScript}
    $states = @('Unknown', 'Disabled', 'Queued', 'Ready', 'Running')
    $messages = @(
      try {
        $filter = switch ($data.app) {
          'codex' { 'OpenAI[. _-]?Codex|\bCodex\b' }
          'claude' { '\bClaude\b|Anthropic' }
          't3-code' { 'T3[. _-]?Code' }
          'opencode' { 'Open[. _-]?Code' }
          default { 'OpenAI[. _-]?Codex|\bCodex\b|\bClaude\b|Anthropic|T3[. _-]?Code|Open[. _-]?Code' }
        }
        foreach ($task in Get-VisibleTasks) {
          $qualifiedName = $task.Path
          if ($qualifiedName -match $filter -and $qualifiedName -match '(?i)updat') {
            "Scheduled update candidate $qualifiedName ($($states[$task.State])): behavior unverified."
          }
        }
      } catch { "Could not inspect scheduled updater tasks: $($_.Exception.Message)" }
    )
    ConvertTo-Json -InputObject $messages -Compress
  `,
            { app },
            10_000,
        );
        return parseInventoryResult(output, (value) => isArrayOf(value, isString));
    } catch (error) {
        return [
            `Could not inspect scheduled updater tasks: ${error instanceof Error ? error.message : String(error)}`,
        ];
    }
}

function describeInstall(app: AppId, type: string): string {
    switch (app) {
        case "codex":
            return type === "npm CLI through Scoop"
                ? "npm manages the installed package. The CLI update check runs at startup."
                : "The CLI update check runs at startup. A closed-app updater is unverified.";
        case "claude":
            return "The native CLI can self-update while it runs. The documented disable switch covers its automatic updater as a whole.";
        case "t3-code":
            return "Electron checks after startup and while the app is running. The app offers download and restart to install.";
        case "opencode":
            return type === "desktop"
                ? "The desktop app checks and downloads through its in-app Electron updater."
                : "The CLI checks from a running session. Its auto-update settings apply to that mechanism.";
        default:
            return "Update mechanism unverified.";
    }
}

export async function showUpdates(paths: SystemPaths, app?: AppId): Promise<void> {
    const inventory = await getAppInventory(paths);
    const [installer, tasks] = await Promise.all([
        getAppInstallerStatus(inventory),
        getUpdaterTaskStatus(app),
    ]);
    for (const id of app ? [app] : appIds) {
        console.log(appNames[id]);
        const installs = inventory.installs.filter((item) => item.id === id);
        const packages = inventory.packages.filter((item) => item.id === id);
        for (const install of installs) {
            console.log(
                `  ${install.type} · ${install.path}\n    ${describeInstall(id, install.type)}`,
            );
        }
        for (const item of packages) {
            console.log(`  ${item.fullName} · ${item.family}`);
            if (id === "claude")
                console.log(
                    "    Claude Desktop self-updates through the app. The enterprise disableAutoUpdates policy is all-or-nothing.",
                );
            const settings = installer.find((entry) => entry.package === item.fullName);
            if (settings) {
                console.log(
                    `    ${settings.state}${settings.manageable ? ` Use updates disable ${id} ${item.family} to turn off its background checks.` : ""}`,
                );
            } else if (!item.registered) {
                console.log(
                    "    App Installer channel and settings unverified because current-user registration could not be confirmed.",
                );
            } else if (item.signature === "Store") {
                console.log(
                    "    Store-signed package. No verified per-app control for Store updates while closed.",
                );
            }
        }
        if (installs.length + packages.length === 0)
            console.log("  No supported installation detected.");
    }
    for (const warning of [...inventory.warnings, ...tasks]) console.warn(warning);
}

export async function disableBackgroundUpdates(
    paths: SystemPaths,
    app: AppId,
    packageFamily?: string,
): Promise<void> {
    const inventory = await getAppInventory(paths);
    const installer = await getAppInstallerStatus(inventory);
    const matches = inventory.packages.filter(
        (item) =>
            item.id === app &&
            (!packageFamily || item.family.toLowerCase() === packageFamily.toLowerCase()),
    );
    const available = matches.filter((item) =>
        installer.some((entry) => entry.package === item.fullName && entry.manageable),
    );
    if (available.length !== 1 || matches.length !== 1) {
        const reason =
            available.length > 1
                ? "Choose a package family from updates status."
                : "Run updates status for the installed update mechanisms.";
        throw new Error(
            `No single verified background-only update control for ${appNames[app]}. ${reason}`,
        );
    }
    const selected = available[0];
    if (!selected) throw new Error("The selected update mechanism is unavailable.");

    const output = await disablePackageBackgroundUpdates(selected);
    console.log(
        `${selected.family} · background update checks ${output === "already-off" ? "already off" : "disabled"} · launch-time checks on`,
    );
}
