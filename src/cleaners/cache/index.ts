import type { SystemPaths } from "../../core/system-paths.ts";
import type { AppCleaner } from "../../core/types.ts";
import { ClaudeCodeCacheCleaner } from "./claude-code-cleaner.ts";
import { ClaudeDesktopCacheCleaner } from "./claude-desktop-cleaner.ts";
import { CodexCacheCleaner } from "./codex-cleaner.ts";
import { DiscordCacheCleaner } from "./discord-cleaner.ts";
import { GitHubDesktopCacheCleaner } from "./github-desktop-cleaner.ts";
import { VSCodeCacheCleaner } from "./vscode-cleaner.ts";

/** General cache cleaners, in checklist order. */
export function createCacheCleaners(paths: SystemPaths): AppCleaner[] {
    return [
        new CodexCacheCleaner(paths),
        new ClaudeCodeCacheCleaner(paths),
        new ClaudeDesktopCacheCleaner(paths),
        new DiscordCacheCleaner(paths),
        new GitHubDesktopCacheCleaner(paths),
        new VSCodeCacheCleaner(paths),
    ];
}
