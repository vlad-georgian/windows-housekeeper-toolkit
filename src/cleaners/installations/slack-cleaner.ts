import { join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { detectSquirrelInstallation } from "../helpers.ts";

export class SlackCleaner extends BaseCleaner {
    readonly id = "slack";
    readonly appId = "slack";
    readonly category = "old-installations";
    readonly label = "Slack";
    readonly description = "Old Slack versions, packages, and dead installs";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectSquirrelInstallation({
            appId: this.id,
            appRoot: join(this.paths.localAppData, "slack"),
            allowedRoot: this.paths.localAppData,
            label: this.label,
        });
    }
}
