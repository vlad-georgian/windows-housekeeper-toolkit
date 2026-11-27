import { join } from "node:path";

import { runCommand } from "../core/command.ts";
import { createFilesystemCandidate, listDirectoryNames } from "../core/filesystem/index.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import type {
    CleanupCandidate,
    CommandRunner,
    RemovalCallbacks,
    RemovalResult,
} from "../core/types.ts";
import { BaseCleaner } from "./base-cleaner.ts";
import {
    parseActiveInfNames,
    parseDriverPackages,
    selectOldInactiveNvidiaDrivers,
} from "./nvidia-driver-packages.ts";

export {
    type DriverPackage,
    parseCsvLine,
    parseDriverPackages,
    selectOldInactiveNvidiaDrivers,
} from "./nvidia-driver-packages.ts";

export class NvidiaDriverCleaner extends BaseCleaner {
    readonly id = "nvidia-drivers";
    readonly label = "NVIDIA drivers";
    readonly description = "Old inactive driver packages and downloaded installers";

    constructor(
        private readonly paths: SystemPaths,
        private readonly commandRunner: CommandRunner = runCommand,
    ) {
        super();
    }

    private async detectDriverPackages(): Promise<CleanupCandidate[]> {
        if (process.platform !== "win32") return [];
        const [driversResult, activeResult] = await Promise.all([
            this.commandRunner(
                ["pnputil.exe", "/enum-drivers", "/class", "Display", "/format", "csv"],
                15_000,
            ),
            this.commandRunner(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "$ErrorActionPreference = 'Stop'; $items = Get-CimInstance Win32_PnPSignedDriver -Filter \"DeviceClass = 'DISPLAY'\" | Where-Object { ($_.Manufacturer -match 'NVIDIA' -or $_.DeviceName -match 'NVIDIA') -and $_.InfName }; @($items | Select-Object -ExpandProperty InfName -Unique) | ConvertTo-Json -Compress",
                ],
                15_000,
            ),
        ]);
        if (driversResult.exitCode !== 0 || activeResult.exitCode !== 0) return [];

        const oldDrivers = selectOldInactiveNvidiaDrivers(
            parseDriverPackages(driversResult.stdout),
            parseActiveInfNames(activeResult.stdout),
        );
        return oldDrivers.map((driver) => ({
            id: `${this.id}:driver:${driver.publishedName}`,
            kind: "driver-package",
            displayName: `NVIDIA display driver ${driver.driverVersion}`,
            reason: `Inactive driver-store package ${driver.publishedName}; active and newer staged packages are retained`,
            sizeBytes: null,
            fileCount: null,
            modifiedAt: null,
            publishedName: driver.publishedName,
            driverVersion: driver.driverVersion,
        }));
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const candidates: CleanupCandidate[] = [];
        const downloader = join(this.paths.programData, "NVIDIA Corporation", "Downloader");
        const downloadFolders = (await listDirectoryNames(downloader)).filter((name) =>
            /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(name),
        );
        for (const folder of ["", ...downloadFolders]) {
            for (const name of await listDirectoryNames(join(downloader, folder))) {
                if (!/^\d+\.\d+-(?:desktop|notebook|quadro|tesla)-[\w-]*whql\.exe$/i.test(name))
                    continue;
                const candidate = await createFilesystemCandidate({
                    id: `${this.id}:download:${folder}:${name}`,
                    path: join(downloader, folder, name),
                    allowedRoot: this.paths.programData,
                    displayName: `NVIDIA driver download ${name}`,
                    reason: "Redownloadable NVIDIA display driver installer",
                    type: "file",
                });
                if (candidate) candidates.push(candidate);
            }
        }

        const extractions = await createFilesystemCandidate({
            id: `${this.id}:extractions`,
            path: join(this.paths.systemDrive, "NVIDIA", "DisplayDriver"),
            allowedRoot: this.paths.systemDrive,
            displayName: "NVIDIA extracted display driver installers",
            reason: "NVIDIA display driver setup extraction cache",
            type: "directory",
        });
        if (extractions && (extractions.fileCount ?? 0) > 0) candidates.push(extractions);

        try {
            candidates.push(...(await this.detectDriverPackages()));
        } catch {
            // Installer caches are still useful if driver-store discovery is unavailable.
        }
        return candidates;
    }

    override async remove(
        candidate: CleanupCandidate,
        callbacks: RemovalCallbacks,
    ): Promise<RemovalResult> {
        if (candidate.kind !== "driver-package") {
            return super.remove(candidate, callbacks);
        }
        if (!candidate.publishedName || !/^oem\d+\.inf$/i.test(candidate.publishedName)) {
            throw new Error(`Invalid NVIDIA driver package ${candidate.publishedName ?? ""}.`);
        }
        const eligible = await this.detectDriverPackages();
        if (
            !eligible.some(
                (driver) =>
                    driver.publishedName === candidate.publishedName &&
                    driver.driverVersion === candidate.driverVersion,
            )
        ) {
            throw new Error(
                `Could not verify that ${candidate.publishedName} is still an inactive NVIDIA driver.`,
            );
        }

        const result = await this.commandRunner([
            "pnputil.exe",
            "/delete-driver",
            candidate.publishedName,
        ]);
        if (result.exitCode !== 0) {
            throw new Error(
                `pnputil refused ${candidate.publishedName}: ${result.stderr || result.stdout}`.trim(),
            );
        }
        await callbacks.onRemoved({
            kind: "driver-package",
            path: candidate.publishedName,
            sizeBytes: null,
            modifiedAt: null,
        });
        return {
            removedEntries: 1,
            reclaimedBytes: 0,
            message: result.stdout.trim(),
        };
    }
}
