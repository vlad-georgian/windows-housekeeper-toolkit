import type { SystemPaths } from "../core/system-paths.ts";
import type { AppCleaner } from "../core/types.ts";
import { createCacheCleaners } from "./cache/index.ts";
import { createInstallationCleaners } from "./installations/index.ts";
import { createPackageCacheCleaners } from "./package-cache/index.ts";

/**
 * The cleaner catalog. Each operation folder registers its own cleaners, one file per app,
 * and each cleaner declares its cleanup category.
 */
export function createCleaners(paths: SystemPaths): readonly AppCleaner[] {
    return [
        ...createCacheCleaners(paths),
        ...createPackageCacheCleaners(paths),
        ...createInstallationCleaners(paths),
    ];
}
