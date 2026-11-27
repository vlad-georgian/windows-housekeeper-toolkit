import { lstat, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { canonicalPathKey, entryIdentity, isUnavailablePath, readSmallTextFile } from '../../core/filesystem/paths.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import { hashFile } from '../tree.ts'
import type { RelocatableApp } from '../types.ts'

export function claudeCodeRelocation(paths: SystemPaths): RelocatableApp {
    const native = join(paths.home, '.local', 'share', 'claude')
    async function ownsLauncher(target: string): Promise<boolean> {
        try {
            const versions = join(await realpath(native), 'versions')
            if (canonicalPathKey(await realpath(versions)) !== canonicalPathKey(versions)) return false
            const launcher = await lstat(target, { bigint: true })
            let digest: string | undefined
            for (const name of await readdir(versions)) {
                if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(name)) continue
                const release = join(versions, name)
                const stats = await lstat(release, { bigint: true })
                if (!stats.isFile() || stats.size !== launcher.size) continue
                if (entryIdentity(stats) === entryIdentity(launcher)) return true
                digest ??= await hashFile(target)
                if (digest === (await hashFile(release))) return true
            }
            return false
        } catch (error) {
            if (isUnavailablePath(error)) return false
            throw error
        }
    }
    return {
        id: 'claude-code',
        processGuardId: 'claude-code',
        label: 'Claude Code',
        preserveMirror: true,
        paths: [
            {
                path: native,
                description: 'native releases',
                verifyLegacyTarget: async () => {
                    try {
                        return await ownsLauncher(await realpath(join(paths.home, '.local', 'bin', 'claude.exe')))
                    } catch (error) {
                        if (isUnavailablePath(error)) return false
                        throw error
                    }
                }
            },
            {
                path: join(paths.home, '.local', 'bin', 'claude.exe'),
                kind: 'file',
                description: 'native launcher',
                nativeLauncherRoot: native,
                verifyFile: ownsLauncher,
                verifyLegacyTarget: ownsLauncher
            },
            {
                path: join(paths.home, '.claude'),
                description: 'user data',
                verifyLegacyTarget: async (target) =>
                    (await readSmallTextFile(join(target, 'settings.json'), target)) !== null && (await lstat(join(target, 'projects')).catch(() => null))?.isDirectory() === true
            },
            { path: join(paths.home, '.claude.json'), kind: 'file', description: 'user configuration' }
        ]
    }
}
