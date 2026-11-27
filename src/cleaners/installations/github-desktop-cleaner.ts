import { join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { detectSquirrelInstallation } from "../helpers.ts";

export class GitHubDesktopInstallationCleaner extends BaseCleaner {
    readonly id = "github-desktop-versions";
    readonly appId = "github-desktop";
    readonly category = "old-installations";
    readonly label = "GitHub Desktop";
    readonly description = "Old Squirrel versions and downloaded update packages";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectSquirrelInstallation({
            appId: this.id,
            appRoot: join(this.paths.localAppData, "GitHubDesktop"),
            allowedRoot: this.paths.localAppData,
            label: this.label,
        });
    }
}
