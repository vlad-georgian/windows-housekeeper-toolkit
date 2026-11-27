import type { SystemPaths } from "../../core/system-paths.ts";
import type { AppCleaner } from "../../core/types.ts";
import { BunCacheCleaner } from "./bun-cleaner.ts";
import { ChocolateyCacheCleaner } from "./chocolatey-cleaner.ts";
import { NpmCacheCleaner } from "./npm-cleaner.ts";
import { NugetCacheCleaner } from "./nuget-cleaner.ts";
import { ScoopCacheCleaner } from "./scoop-cleaner.ts";

/** Destructive package download cache cleaners, in checklist order. */
export function createPackageCacheCleaners(paths: SystemPaths): AppCleaner[] {
    return [
        new NpmCacheCleaner(paths),
        new BunCacheCleaner(paths),
        new ScoopCacheCleaner(paths),
        new ChocolateyCacheCleaner(paths),
        new NugetCacheCleaner(paths),
    ];
}
