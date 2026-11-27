import { basename, join } from "node:path";

import { runCommand } from "../../core/command.ts";
import { createFilesystemCandidate, listDirectoryNames } from "../../core/filesystem/index.ts";
import type { SystemPaths } from "../../core/system-paths.ts";
import type {
    CleanupCandidate,
    CommandRunner,
    RemovalCallbacks,
    RemovalResult,
} from "../../core/types.ts";
import { compareVersions } from "../../core/versions.ts";
import { BaseCleaner } from "../base-cleaner.ts";

export class ClaudeCodeInstallationCleaner extends BaseCleaner {
    readonly id = "claude-code-versions";
    readonly appId = "claude-code";
    readonly category = "old-installations";
    readonly label = "Claude Code";
    readonly description = "Superseded native Claude Code binaries";

    constructor(
        private readonly paths: SystemPaths,
        private readonly commandRunner: CommandRunner = runCommand,
    ) {
        super();
    }

    private async currentVersion(): Promise<string | null> {
        try {
            const result = await this.commandRunner(["claude", "--version"]);
            if (result.exitCode !== 0) return null;
            return result.stdout.match(/\d+(?:\.\d+){1,3}/)?.[0] ?? null;
        } catch {
            return null;
        }
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const versionsRoot = join(this.paths.home, ".local", "share", "claude", "versions");
        const versions = (await listDirectoryNames(versionsRoot))
            .filter((name) => /^\d+(?:\.\d+){1,3}(?:[-+].*)?$/.test(name))
            .toSorted((left, right) => compareVersions(right, left));
        const newest = versions[0] ?? null;
        const current = newest ? await this.currentVersion() : null;
        const retained = new Set(
            [newest, current].filter((value): value is string => Boolean(value)),
        );
        const candidates: CleanupCandidate[] = [];

        for (const version of versions) {
            if (
                !current ||
                !versions.includes(current) ||
                retained.has(version) ||
                compareVersions(version, current) >= 0
            ) {
                continue;
            }
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:version:${version}`,
                path: join(versionsRoot, version),
                allowedRoot: versionsRoot,
                displayName: `Claude Code ${version}`,
                reason: `Superseded native binary; retaining ${[...retained].join(" and ")}`,
            });
            if (candidate) candidates.push(candidate);
        }
        return candidates;
    }

    override async remove(
        candidate: CleanupCandidate,
        callbacks: RemovalCallbacks,
    ): Promise<RemovalResult> {
        if (candidate.id.startsWith(`${this.id}:version:`)) {
            const current = await this.currentVersion();
            const versions = candidate.allowedRoot
                ? await listDirectoryNames(candidate.allowedRoot)
                : [];
            const name = candidate.path ? basename(candidate.path) : null;
            if (
                !current ||
                !versions.includes(current) ||
                !name ||
                compareVersions(current, name) <= 0
            ) {
                throw new Error(`Could not verify that ${candidate.displayName} is superseded.`);
            }
        }
        return super.remove(candidate, callbacks);
    }
}
