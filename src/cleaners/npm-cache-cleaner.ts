import { join } from "node:path";

import { createFilesystemCandidate } from "../core/filesystem/index.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import type { CleanupCandidate } from "../core/types.ts";
import { BaseCleaner } from "./base-cleaner.ts";

export class NpmCacheCleaner extends BaseCleaner {
    readonly id = "npm-cache";
    readonly label = "npm package cache";
    readonly description = "Downloaded npm package archives and metadata";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const candidates: CleanupCandidate[] = [];
        for (const [location, appData] of [
            ["local", this.paths.localAppData],
            ["roaming", this.paths.roamingAppData],
        ] as const) {
            const root = join(appData, "npm-cache");
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:${location}`,
                path: join(root, "_cacache"),
                allowedRoot: root,
                displayName: `npm download cache (${location})`,
                reason: "Content-addressed package downloads and package metadata",
                type: "directory",
            });
            if (candidate && (candidate.fileCount ?? 0) > 0) candidates.push(candidate);
        }
        return candidates;
    }
}
