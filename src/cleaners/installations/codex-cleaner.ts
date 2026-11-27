import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from "../../core/types.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { codexHome } from "../helpers.ts";
import { detectCodexInstallations, removeCodexInstallation } from "./codex-installations.ts";

export class CodexInstallationCleaner extends BaseCleaner {
    readonly id = "codex-releases";
    readonly appId = "codex";
    readonly category = "old-installations";
    readonly label = "Codex";
    readonly description = "Superseded standalone and daemon releases and npm update residue";
    // Release removal checks the running Codex binaries and holds the installer lock itself.
    readonly manualRunningAppCheck = false;

    constructor(private readonly paths: SystemPaths) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectCodexInstallations(codexHome(this.paths), this.paths);
    }

    override remove(
        candidate: CleanupCandidate,
        callbacks: RemovalCallbacks,
    ): Promise<RemovalResult> {
        if (candidate.id.startsWith("codex:release:") || candidate.id.startsWith("codex:npm:")) {
            return removeCodexInstallation(candidate, codexHome(this.paths), () =>
                super.remove(candidate, callbacks),
            );
        }
        return super.remove(candidate, callbacks);
    }
}
