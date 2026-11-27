import { join } from "node:path";

import type { SystemPaths } from "../core/system-paths.ts";
import type { CleanupCandidate } from "../core/types.ts";
import { BaseCleaner } from "./base-cleaner.ts";
import { detectSquirrelInstallation } from "./helpers.ts";

export class BalenaEtcherCleaner extends BaseCleaner {
    readonly id = "balena-etcher";
    readonly label = "balenaEtcher";
    readonly description = "Old balenaEtcher versions, packages, and dead installs";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectSquirrelInstallation({
            appId: this.id,
            appRoot: join(this.paths.localAppData, "balena_etcher"),
            allowedRoot: this.paths.localAppData,
            label: this.label,
        });
    }
}
