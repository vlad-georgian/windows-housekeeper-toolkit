import { join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { detectNamedCaches } from "../helpers.ts";

export class VSCodeCacheCleaner extends BaseCleaner {
    readonly id = "vscode";
    readonly appId = "vscode";
    readonly category = "general-cache";
    readonly label = "Visual Studio Code";
    readonly description = "Downloaded extension archives, runtime caches, and Chromium caches";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectNamedCaches(this.id, this.label, join(this.paths.roamingAppData, "Code"), [
            ["CachedExtensionVSIXs", "Downloaded extension archives and backups of those archives"],
            ["CachedData", "Regenerable VS Code runtime cache"],
            ["Cache", "Regenerable Chromium HTTP cache"],
            ["Code Cache", "Regenerable Chromium compiled code cache"],
            ["GPUCache", "Regenerable Chromium GPU cache"],
        ]);
    }
}
