import { isAbsolute, join } from "node:path";

import {
    createFilesystemCandidate,
    isPathInside,
    listDirectoryNames,
    pathExists,
    readSmallTextFile,
} from "../../core/filesystem/index.ts";
import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import type { Environment } from "../helpers.ts";

const cacheLocationSetting = /<add\s+key="cacheLocation"\s+value="([^"]*)"/i;

export class ChocolateyCacheCleaner extends BaseCleaner {
    readonly id = "chocolatey-cache";
    readonly appId = "chocolatey-cache";
    readonly category = "destructive-cache";
    readonly label = "Chocolatey download cache";
    readonly description = "Downloaded Chocolatey packages and installers in the user's Temp";
    readonly implications =
        "Chocolatey downloads packages again to install, upgrade, or repair them, and offline installs fail. Installed packages under the Chocolatey installation are preserved.";

    constructor(
        private readonly paths: SystemPaths,
        private readonly environment: Environment = process.env,
    ) {
        super();
    }

    /** Chocolatey caches downloads in `%TEMP%\chocolatey` unless `cacheLocation` is set. */
    private async verifiedCacheRoot(): Promise<string | null> {
        const install = this.environment.ChocolateyInstall;
        if (!install || !isAbsolute(install) || !(await pathExists(join(install, "choco.exe")))) {
            return null;
        }
        const config = await readSmallTextFile(
            join(install, "config", "chocolatey.config"),
            install,
        );
        const cacheLocation = config && cacheLocationSetting.exec(config)?.[1];
        if (cacheLocation !== "") return null;
        const root = join(this.paths.temp, "chocolatey");
        return isPathInside(root, this.paths.home) ? root : null;
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = await this.verifiedCacheRoot();
        if (!root) return [];
        const candidates: CleanupCandidate[] = [];
        for (const name of await listDirectoryNames(root)) {
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:${name}`,
                path: join(root, name),
                allowedRoot: root,
                displayName: `Chocolatey cached ${name}`,
                reason: "Downloaded package or installer in the Chocolatey download cache",
            });
            if (candidate) candidates.push(candidate);
        }
        return candidates;
    }
}
