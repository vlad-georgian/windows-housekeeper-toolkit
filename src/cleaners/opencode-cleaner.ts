import { join } from 'node:path'

import { createFilesystemCandidate, listDirectoryNames, readSmallTextFile } from '../core/filesystem/index.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../core/types.ts'
import { runPowerShell } from '../windows/powershell.ts'
import { BaseCleaner } from './base-cleaner.ts'

const updaterName = '@opencodedesktop-updater'
const updaterConfig = /^updaterCacheDirName:[ \t]*['"]?@opencodedesktop-updater['"]?[ \t]*\r?$/m
const openCodeFeed = /^url:[ \t]*['"]?https:\/\/opencode\.ai\/update\/api\/latest\/desktop\/opencode\/['"]?[ \t]*\r?$/m
const installerName = /^opencode-desktop-win-(?:x64|arm64)\.exe$/i
const temporaryPayload = /^(?:temp-(?:\d+-)?opencode-desktop-win-(?:x64|arm64)\.exe|opencode-desktop-win-(?:x64|arm64)\.exe\.blockmap|current\.blockmap)$/i

function pendingInstallerName(metadata: string | null): string | null {
    if (!metadata) return null
    try {
        const info: unknown = JSON.parse(metadata)
        if (typeof info !== 'object' || info === null || !('fileName' in info)) return null
        return typeof info.fileName === 'string' && installerName.test(info.fileName) ? info.fileName : null
    } catch {
        return null
    }
}

export class OpenCodeCleaner extends BaseCleaner {
    readonly id = 'opencode'
    readonly label = 'OpenCode Desktop'
    readonly description = 'Verified OpenCode Desktop installer downloads'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    private get installRoot(): string {
        return join(this.paths.localAppData, 'Programs', 'ai.opencode.desktop')
    }

    private async installerMatchesInstalledVersion(payload: string): Promise<boolean> {
        try {
            const result = await runPowerShell(
                String.raw`
          $installed = [Diagnostics.FileVersionInfo]::GetVersionInfo($data.installed)
          $payload = [Diagnostics.FileVersionInfo]::GetVersionInfo($data.payload)
          $installedVersion = $installed.ProductVersion -replace '^(\d+\.\d+\.\d+)\.0$', '$1'
          $payloadVersion = $payload.ProductVersion -replace '^(\d+\.\d+\.\d+)\.0$', '$1'
          if ($installed.ProductName -eq 'OpenCode' -and $payload.ProductName -eq 'OpenCode' -and
              $installedVersion -match '^\d+\.\d+\.\d+$' -and $installedVersion -eq $payloadVersion) {
            'verified'
          }
        `,
                { installed: join(this.installRoot, 'OpenCode.exe'), payload },
                5_000
            )
            return result === 'verified'
        } catch {
            return false
        }
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const allowedRoot = this.paths.localAppData
        const config = await readSmallTextFile(join(this.installRoot, 'resources', 'app-update.yml'), allowedRoot)
        if (!config || !updaterConfig.test(config) || !openCodeFeed.test(config)) return []

        const updaterRoot = join(allowedRoot, updaterName)
        const pending = join(updaterRoot, 'pending')
        const candidates: CleanupCandidate[] = []
        const namedInstaller = pendingInstallerName(await readSmallTextFile(join(pending, 'update-info.json'), allowedRoot))
        if (namedInstaller) {
            const cachedPath = join(updaterRoot, 'installer.exe')
            const pendingPath = join(pending, namedInstaller)
            const installer = {
                allowedRoot,
                displayName: 'OpenCode Desktop cached installer for the installed version',
                reason: 'The installer version matches the installed OpenCode Desktop version',
                type: 'file'
            } as const
            const linked = await createFilesystemCandidate({
                ...installer,
                id: `${this.id}:installed-installer:linked`,
                path: cachedPath,
                aliases: [pendingPath]
            })
            const downloads = linked
                ? [linked]
                : await Promise.all([
                      createFilesystemCandidate({
                          ...installer,
                          id: `${this.id}:installed-installer:cache`,
                          path: cachedPath
                      }),
                      createFilesystemCandidate({
                          ...installer,
                          id: `${this.id}:installed-installer:pending`,
                          path: pendingPath
                      })
                  ])
            for (const candidate of downloads) {
                if (candidate?.canonicalPath && (await this.installerMatchesInstalledVersion(candidate.canonicalPath))) {
                    candidates.push(candidate)
                }
            }
        }

        for (const [directory, folder] of [
            [updaterRoot, 'cache'],
            [pending, 'pending']
        ] as const) {
            for (const name of await listDirectoryNames(directory)) {
                if (!temporaryPayload.test(name)) continue
                const candidate = await createFilesystemCandidate({
                    id: `${this.id}:updater:${folder}:${name}`,
                    path: join(directory, name),
                    allowedRoot,
                    displayName: `OpenCode Desktop downloaded ${name}`,
                    reason: 'Temporary installer download or regenerable differential update metadata',
                    type: 'file'
                })
                if (candidate) candidates.push(candidate)
            }
        }
        return candidates
    }

    override async remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        if (candidate.id.startsWith(`${this.id}:installed-installer:`) && (!candidate.canonicalPath || !(await this.installerMatchesInstalledVersion(candidate.canonicalPath)))) {
            throw new Error('The cached OpenCode installer no longer matches the installed version.')
        }
        return super.remove(candidate, callbacks)
    }
}
