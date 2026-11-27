import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SystemPaths } from "../../core/system-paths.ts";
import {
    codexConfiguration,
    updateCodexLogSetting,
    verifyCodexConfiguration,
} from "./codex-config.ts";
import { assertCodexClosed } from "./codex-environment.ts";
import {
    copyVerifiedLog,
    inspectFile,
    logNames,
    plainDirectory,
    removeVerifiedLog,
    sameFile,
    verifyCapacity,
} from "./files.ts";
import { savePhase, type Migration } from "./journal.ts";
import { bytes, checkLocations, snapshot, sourcePath, verifySnapshot } from "./snapshot.ts";

export async function finishRollback(paths: SystemPaths, operation: Migration): Promise<void> {
    await assertCodexClosed();
    await checkLocations(operation);
    const config = join(operation.home, "config.toml");
    const { settings } = await codexConfiguration(config);
    if (["copying", "redirecting"].includes(operation.phase) && settings.log_dir === undefined) {
        await savePhase(paths, operation, "rolled-back");
        console.log(
            `Canceled the Codex migration before reclaiming source files. Any destination copies are at ${operation.destination}.`,
        );
        return;
    }

    if (operation.phase !== "restoring-setting" || settings.log_dir !== undefined) {
        await verifyCodexConfiguration(paths, operation.home, operation.destination, operation.id);
        const latest = await snapshot(operation.destination, true);
        if (latest.length === 0)
            throw new Error("There are no verified destination log files to restore.");
        const known = [
            ...operation.original,
            ...operation.rollbackSource,
            ...(operation.latest ?? []),
        ];
        const rollbackSource = await verifySnapshot(operation.home, false, known, true);
        operation = await savePhase(
            paths,
            { ...operation, latest, rollbackSource },
            "rolling-back",
        );
        const originals = new Map(rollbackSource.map((file) => [file.name, file]));
        const restoring = new Map(latest.map((file) => [file.name, file]));
        const toCopy = [];
        const toRemove = [];
        for (const name of logNames) {
            const file = restoring.get(name);
            const target = sourcePath(operation.home, name);
            const existing = await inspectFile(target, name);
            if (existing && (!file || !sameFile(existing, file))) {
                const previous = originals.get(name);
                if (!previous || !sameFile(existing, previous)) {
                    throw new Error(`A different file already exists at ${target}.`);
                }
            }
            if (file && !sameFile(existing, file)) toCopy.push({ file, target, existing });
            if (!file && existing) toRemove.push({ file: existing, target });
        }
        await verifyCapacity(operation.home, bytes(toCopy.map((entry) => entry.file)));
        for (const { file, target, existing } of toCopy) {
            if (!(await plainDirectory(dirname(target)))) await mkdir(dirname(target));
            await copyVerifiedLog(
                join(operation.destination, file.name),
                target,
                file,
                operation.id,
                existing,
            );
        }
        for (const { file, target } of toRemove) await removeVerifiedLog(target, file);
        await verifySnapshot(operation.home, false, latest);
        await verifySnapshot(operation.destination, true, latest);
        await assertCodexClosed();
        operation = await savePhase(paths, operation, "restoring-setting");
        await updateCodexLogSetting(config, operation.destination, operation.id, true);
    }
    await verifyCodexConfiguration(paths, operation.home, operation.priorLogDir);
    await savePhase(paths, operation, "rolled-back");
    console.log(
        `Restored Codex diagnostics at ${operation.home}. The destination copy remains at ${operation.destination}.`,
    );
}
