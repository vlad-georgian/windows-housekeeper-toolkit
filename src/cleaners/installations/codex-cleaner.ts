import type { SystemPaths } from "../../core/system-paths.ts";
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from "../../core/types.ts";
import { listWindowsProcesses } from "../../windows/processes.ts";
import { BaseCleaner } from "../base-cleaner.ts";
import { codexHome } from "../helpers.ts";
import {
    detectCodexInstallations,
    type ProcessLister,
    removeCodexInstallation,
} from "./codex-installations.ts";

export class CodexInstallationCleaner extends BaseCleaner {
    readonly id = "codex-releases";
    readonly appId = "codex";
    readonly category = "old-installations";
    readonly label = "Codex";
    readonly description = "Superseded standalone and daemon releases and npm update residue";
    // Release and npm residue removal checks the running Codex binaries itself, and release
    // removal holds the installer lock.
    readonly manualRunningAppCheck = false;

    constructor(
        private readonly paths: SystemPaths,
        private readonly listProcesses: ProcessLister = listWindowsProcesses,
    ) {
        super();
    }

    detect(): Promise<readonly CleanupCandidate[]> {
        return detectCodexInstallations(codexHome(this.paths), this.paths, this.listProcesses);
    }

    override remove(
        candidate: CleanupCandidate,
        callbacks: RemovalCallbacks,
    ): Promise<RemovalResult> {
        if (candidate.id.startsWith("codex:release:") || candidate.id.startsWith("codex:npm:")) {
            return removeCodexInstallation(
                candidate,
                codexHome(this.paths),
                () => super.remove(candidate, callbacks),
                this.listProcesses,
            );
        }
        return super.remove(candidate, callbacks);
    }
}
