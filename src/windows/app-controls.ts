import { getSystemPaths } from "../core/system-paths.ts";
import { type AppId, appIds, isAppId } from "./app-catalog.ts";
import {
    disableStartup,
    openStartupSettings,
    showStartup,
    restoreStartup,
} from "./app-startup/index.ts";
import { disableBackgroundUpdates, showUpdates } from "./app-updates/index.ts";

function getAppId(value: string): AppId {
    if (!isAppId(value)) {
        throw new Error(`Unknown app ${JSON.stringify(value)}. Choose ${appIds.join(", ")}.`);
    }
    return value;
}

export async function runAppControls(args: readonly string[]): Promise<void> {
    const [command, action, value, detail, extra] = args;
    const paths = getSystemPaths();
    if ((command !== "startup" && command !== "updates") || extra !== undefined)
        throw new Error("Invalid app control command.");
    if (action === "status" && detail === undefined) {
        const app = value === undefined ? undefined : getAppId(value);
        await (command === "startup" ? showStartup(paths, app) : showUpdates(paths, app));
        return;
    }
    if (command === "startup" && action === "settings" && value === undefined) {
        await openStartupSettings();
        return;
    }
    if (value !== undefined && action === "disable") {
        const app = getAppId(value);
        await (command === "startup"
            ? disableStartup(paths, app, detail)
            : disableBackgroundUpdates(paths, app, detail));
        return;
    }
    if (command === "startup" && action === "restore" && value !== undefined) {
        await restoreStartup(paths, getAppId(value), detail);
        return;
    }
    throw new Error(
        command === "startup"
            ? "Usage: startup status [app] | startup disable <app> [entry] | startup restore <app> [entry] | startup settings"
            : "Usage: updates status [app] | updates disable <app> [package-family]",
    );
}
