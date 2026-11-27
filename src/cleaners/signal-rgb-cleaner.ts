import { join } from "node:path";

import type { SystemPaths } from "../core/system-paths.ts";
import type { CleanupCandidate } from "../core/types.ts";
import { BaseCleaner } from "./base-cleaner.ts";
import { detectSquirrelInstallation } from "./helpers.ts";

export class SignalRgbCleaner extends BaseCleaner {
    readonly id = "signal-rgb";
    readonly label = "SignalRGB / VortxEngine";
    readonly description = "Old SignalRGB application folders and update packages";

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectSquirrelInstallation({
            appId: this.id,
            appRoot: join(this.paths.localAppData, "VortxEngine"),
            allowedRoot: this.paths.localAppData,
            label: this.label,
        });
    }
}
