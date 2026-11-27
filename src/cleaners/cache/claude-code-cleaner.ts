import { join } from "node:path";

import { createFilesystemCandidate } from "../../core/filesystem/index.ts";
import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";

export class ClaudeCodeCacheCleaner extends BaseCleaner {
    readonly id = "claude-code";
    readonly appId = "claude-code";
    readonly category = "general-cache";
    readonly label = "Claude Code";
    readonly description = "Regenerable Claude Code changelog and API metadata cache";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const cache = await createFilesystemCandidate({
            id: `${this.id}:cache`,
            path: join(this.paths.home, ".claude", "cache"),
            allowedRoot: join(this.paths.home, ".claude"),
            displayName: "Claude Code regenerable cache",
            reason: "Cached changelog and API metadata; projects, settings, and backups are preserved",
        });
        return cache && (cache.fileCount ?? 0) > 0 ? [cache] : [];
    }
}
