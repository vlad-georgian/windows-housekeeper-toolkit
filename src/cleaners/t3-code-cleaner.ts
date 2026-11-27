import { join } from "node:path";

import type { SystemPaths } from "../core/system-paths.ts";
import type { CleanupCandidate } from "../core/types.ts";
import { BaseCleaner } from "./base-cleaner.ts";
import { detectUpdaterDirectory } from "./helpers.ts";

export class T3CodeCleaner extends BaseCleaner {
    readonly id = "t3-code";
    readonly label = "T3 Code";
    readonly description = "Downloaded and pending T3 Code installers";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectUpdaterDirectory({
            appId: this.id,
            updaterRoot: join(this.paths.localAppData, "t3code-updater"),
            allowedRoot: this.paths.localAppData,
            label: this.label,
        });
    }
}
