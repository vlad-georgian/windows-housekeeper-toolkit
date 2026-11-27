import { join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { chromiumCaches, detectNamedCaches } from "../helpers.ts";

export class GitHubDesktopCacheCleaner extends BaseCleaner {
    readonly id = "github-desktop";
    readonly appId = "github-desktop";
    readonly category = "general-cache";
    readonly label = "GitHub Desktop";
    readonly description = "Chromium caches in the GitHub Desktop profile";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        const profile = join(this.paths.roamingAppData, "GitHub Desktop");
        return detectNamedCaches(this.id, this.label, profile, chromiumCaches);
    }
}
