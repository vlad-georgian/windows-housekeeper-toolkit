import type { BigIntStats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { FilesystemIdentity } from "../types.ts";

interface ResolvedTarget {
    readonly path: string;
    readonly stats: BigIntStats;
    readonly identity: FilesystemIdentity;
}

export class UnverifiedPathError extends Error {}

export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
    return error instanceof Error && "code" in error && codes.some((code) => code === error.code);
}

export function isUnavailablePath(error: unknown): boolean {
    return hasErrorCode(error, "ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY", "ELOOP");
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (hasErrorCode(error, "ENOENT", "ENOTDIR")) return false;
        throw error;
    }
}

export function canonicalPathKey(path: string): string {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathInside(path: string, root: string): boolean {
    const difference = relative(canonicalPathKey(root), canonicalPathKey(path));
    return (
        difference !== "" &&
        difference !== ".." &&
        !difference.startsWith(`..${sep}`) &&
        !isAbsolute(difference)
    );
}

export function entryIdentity(stats: BigIntStats): string {
    return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

export async function inspectCanonicalEntry(path: string, linkCount = 1n): Promise<BigIntStats> {
    const stats = await lstat(path, { bigint: true });
    if (
        (!stats.isDirectory() && !stats.isFile()) ||
        (stats.isFile() && stats.nlink !== linkCount) ||
        canonicalPathKey(await realpath(path)) !== canonicalPathKey(path)
    ) {
        throw new UnverifiedPathError(`Could not verify the filesystem links at ${path}.`);
    }
    return stats;
}

export async function resolveTarget(
    path: string,
    allowedRoot: string,
    linkCount = 1n,
): Promise<ResolvedTarget> {
    if (!isPathInside(path, allowedRoot)) {
        throw new UnverifiedPathError(`${path} is outside its expected application directory.`);
    }

    const canonicalRoot = await realpath(allowedRoot);
    const rootStats = await inspectCanonicalEntry(canonicalRoot);
    if (!rootStats.isDirectory()) {
        throw new UnverifiedPathError(`${allowedRoot} is not a directory.`);
    }

    const canonicalPath = resolve(canonicalRoot, relative(allowedRoot, path));
    if (canonicalPathKey(await realpath(path)) !== canonicalPathKey(canonicalPath)) {
        throw new UnverifiedPathError(
            `${path} redirects outside its expected application location.`,
        );
    }
    const stats = await inspectCanonicalEntry(canonicalPath, linkCount);
    return {
        path: canonicalPath,
        stats,
        identity: { target: entryIdentity(stats), allowedRoot: entryIdentity(rootStats) },
    };
}

export function hasIdentity(target: ResolvedTarget, expected: FilesystemIdentity): boolean {
    return (
        target.identity.target === expected.target &&
        target.identity.allowedRoot === expected.allowedRoot
    );
}

export async function resolveTargetGroup(
    path: string,
    aliases: readonly string[],
    allowedRoot: string,
): Promise<{ target: ResolvedTarget; aliases: ResolvedTarget[] }> {
    const allPaths = [path, ...aliases];
    if (new Set(allPaths.map(canonicalPathKey)).size !== allPaths.length) {
        throw new UnverifiedPathError(`Duplicate filesystem links for ${path}.`);
    }
    const expectedLinks = BigInt(allPaths.length);
    const target = await resolveTarget(path, allowedRoot, expectedLinks);
    const resolvedAliases: ResolvedTarget[] = [];
    for (const alias of aliases) {
        const resolved = await resolveTarget(alias, allowedRoot, expectedLinks);
        if (!resolved.stats.isFile() || !hasIdentity(resolved, target.identity)) {
            throw new UnverifiedPathError(`${alias} is not a hardlink to ${path}.`);
        }
        resolvedAliases.push(resolved);
    }
    return { target, aliases: resolvedAliases };
}

export async function listDirectoryNames(path: string): Promise<string[]> {
    try {
        return await readdir(path);
    } catch (error) {
        if (isUnavailablePath(error)) return [];
        throw error;
    }
}

export async function readSmallTextFile(path: string, allowedRoot: string): Promise<string | null> {
    try {
        const target = await resolveTarget(path, allowedRoot);
        if (!target.stats.isFile() || target.stats.size > 131072n) return null;
        return await readFile(target.path, "utf8");
    } catch (error) {
        if (error instanceof UnverifiedPathError || isUnavailablePath(error)) return null;
        throw error;
    }
}

export function parentOf(path: string): string {
    return dirname(resolve(path));
}
