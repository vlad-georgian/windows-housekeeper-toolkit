import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { runCommand } from '../../core/command.ts'
import { canonicalPathKey, createFilesystemCandidate, listDirectoryNames } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, CommandRunner, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { compareVersions } from '../../core/versions.ts'
import { listWindowsProcesses, type ProcessLister } from '../../windows/processes.ts'
import { BaseCleaner } from '../base-cleaner.ts'
import { isPathInUse, runningProcessPaths } from './running-paths.ts'

const versionName = /^\d+(?:\.\d+){1,3}(?:[-+].*)?$/
const claudeProcess = /^claude(?:\.exe)?$/i

export class ClaudeCodeInstallationCleaner extends BaseCleaner {
    readonly id = 'claude-code-versions'
    readonly appId = 'claude-code'
    readonly category = 'old-installations'
    readonly label = 'Claude Code'
    readonly description = 'Superseded native Claude Code binaries'
    // Claude Code is routinely running, so removal checks the version binaries' own use instead.
    readonly manualRunningAppCheck = false

    constructor(
        private readonly paths: SystemPaths,
        private readonly commandRunner: CommandRunner = runCommand,
        private readonly listProcesses: ProcessLister = listWindowsProcesses
    ) {
        super()
    }

    private versionsRoot(): string {
        return join(this.paths.home, '.local', 'share', 'claude', 'versions')
    }

    /**
     * The active native version. Ask the native launcher itself, never `claude` on `PATH`, which
     * can resolve to a different installation such as an npm package.
     */
    private async activeVersion(): Promise<string | null> {
        const launcher = join(this.paths.home, '.local', 'bin', 'claude.exe')
        try {
            // The Windows installer copies the active binary to the launcher. A link is not that copy.
            if (!(await lstat(launcher)).isFile()) return null
            const result = await this.commandRunner([launcher, '--version'])
            return result.exitCode === 0 ? (/^\s*(\d+(?:\.\d+){1,3})\b/.exec(result.stdout)?.[1] ?? null) : null
        } catch {
            return null
        }
    }

    private async inspect(): Promise<{ root: string; active: string; versions: string[] } | null> {
        const root = this.versionsRoot()
        const versions = (await listDirectoryNames(root)).filter((name) => versionName.test(name))
        const active = versions.length > 0 ? await this.activeVersion() : null
        return active && versions.includes(active) ? { root, active, versions } : null
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const installation = await this.inspect()
        if (!installation) return []
        const processes = await runningProcessPaths(this.listProcesses, claudeProcess)
        if (processes === null) return []

        // Newer versions are a staged update, so only versions older than the active one qualify.
        const candidates: CleanupCandidate[] = []
        for (const version of installation.versions.toSorted((left, right) => compareVersions(right, left))) {
            if (compareVersions(version, installation.active) >= 0 || isPathInUse(join(installation.root, version), processes)) continue
            const candidate = await createFilesystemCandidate({
                id: `${this.id}:version:${version}`,
                path: join(installation.root, version),
                allowedRoot: installation.root,
                displayName: `Claude Code ${version}`,
                reason: `Superseded native binary; the active version ${installation.active} is retained`
            })
            if (candidate) candidates.push(candidate)
        }
        return candidates
    }

    override async remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        if (candidate.id.startsWith(`${this.id}:version:`)) {
            const name = candidate.path ? basename(candidate.path) : null
            const installation = await this.inspect()
            const processes = await runningProcessPaths(this.listProcesses, claudeProcess)
            if (
                !installation ||
                processes === null ||
                !name ||
                candidate.id !== `${this.id}:version:${name}` ||
                !candidate.allowedRoot ||
                canonicalPathKey(candidate.allowedRoot) !== canonicalPathKey(installation.root) ||
                !installation.versions.includes(name) ||
                compareVersions(installation.active, name) <= 0
            ) {
                throw new Error(`Could not verify that ${candidate.displayName} is superseded.`)
            }
            if (isPathInUse(candidate.canonicalPath ?? join(installation.root, name), processes)) {
                throw new Error(`${candidate.displayName} is in use.`)
            }
        }
        return super.remove(candidate, callbacks)
    }
}
