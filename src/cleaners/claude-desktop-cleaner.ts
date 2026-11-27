import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import { canonicalPathKey, isUnavailablePath } from "../core/filesystem/index.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import type { CleanupCandidate } from "../core/types.ts";
import { BaseCleaner } from "./base-cleaner.ts";
import { detectNamedCaches } from "./helpers.ts";

const packageFamily = "Claude_pzs8sxrjxfjjc";
const profileLocation = join("LocalCache", "Roaming", "Claude");

export class ClaudeDesktopCleaner extends BaseCleaner {
    readonly id = "claude-desktop";
    readonly label = "Claude Desktop";
    readonly description = "Chromium caches in the Claude Desktop Windows package profile";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const packageRoot = join(this.paths.localAppData, "Packages", packageFamily);
        const profile = join(packageRoot, profileLocation);
        try {
            const canonicalPackage = await realpath(packageRoot);
            if (
                basename(canonicalPackage).toLowerCase() !== packageFamily.toLowerCase() ||
                canonicalPathKey(await realpath(profile)) !==
                    canonicalPathKey(join(canonicalPackage, profileLocation))
            ) {
                return [];
            }
        } catch (error) {
            if (isUnavailablePath(error)) return [];
            throw error;
        }

        return detectNamedCaches(this.id, this.label, profile, [
            ["Cache", "Regenerable Chromium HTTP cache"],
            ["Code Cache", "Regenerable Chromium compiled code cache"],
            ["GPUCache", "Regenerable Chromium GPU cache"],
            ["DawnGraphiteCache", "Regenerable Chromium graphics cache"],
            ["DawnWebGPUCache", "Regenerable Chromium WebGPU cache"],
        ]);
    }
}
