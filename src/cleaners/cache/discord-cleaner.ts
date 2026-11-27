import { join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { chromiumCaches, detectNamedCaches } from "../helpers.ts";

export class DiscordCacheCleaner extends BaseCleaner {
    readonly id = "discord";
    readonly appId = "discord";
    readonly category = "general-cache";
    readonly label = "Discord";
    readonly description = "Chromium caches in the Discord profile";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        const profile = join(this.paths.roamingAppData, "discord");
        return detectNamedCaches(this.id, this.label, profile, chromiumCaches);
    }
}
