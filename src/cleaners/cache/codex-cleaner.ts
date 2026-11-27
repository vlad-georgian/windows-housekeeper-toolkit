import { join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { codexHome, detectNamedCaches } from "../helpers.ts";

export class CodexCacheCleaner extends BaseCleaner {
    readonly id = "codex";
    readonly appId = "codex";
    readonly category = "general-cache";
    readonly label = "Codex";
    readonly description = "Regenerable Codex metadata and plugin catalog caches";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectNamedCaches(this.id, this.label, codexHome(this.paths), [
            [
                join("cache", "bundled_plugin_exclusions"),
                "Regenerable bundled plugin exclusions cache",
            ],
            [join("cache", "codex_app_directory"), "Regenerable application directory cache"],
            [join("cache", "codex_apps_server_info"), "Regenerable app server metadata cache"],
            [join("cache", "codex_apps_tools"), "Regenerable app tool metadata cache"],
            [join("cache", "remote_plugin_catalog"), "Regenerable remote plugin catalog cache"],
        ]);
    }
}
