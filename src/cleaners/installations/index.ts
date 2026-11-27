import type { SystemPaths } from '../../core/system-paths.ts'
import type { AppCleaner } from '../../core/types.ts'
import { AmdInstallerCleaner } from './amd-installer-cleaner.ts'
import { BalenaEtcherCleaner } from './balena-etcher-cleaner.ts'
import { ChatboxCleaner } from './chatbox-cleaner.ts'
import { ClaudeCodeInstallationCleaner } from './claude-code-cleaner.ts'
import { CodexInstallationCleaner } from './codex-cleaner.ts'
import { DiscordInstallationCleaner } from './discord-cleaner.ts'
import { GitHubDesktopInstallationCleaner } from './github-desktop-cleaner.ts'
import { LinuaCleaner } from './linua-cleaner.ts'
import { NotionCleaner } from './notion-cleaner.ts'
import { NvidiaDriverCleaner } from './nvidia-driver-cleaner.ts'
import { ObsidianCleaner } from './obsidian-cleaner.ts'
import { OpenCodeCleaner } from './opencode-cleaner.ts'
import { SignalRgbCleaner } from './signal-rgb-cleaner.ts'
import { SlackCleaner } from './slack-cleaner.ts'
import { T3CodeCleaner } from './t3-code-cleaner.ts'
import { VortexCleaner } from './vortex-cleaner.ts'

/** Old data and installation cleaners, in checklist order. */
export function createInstallationCleaners(paths: SystemPaths): AppCleaner[] {
    return [
        new CodexInstallationCleaner(paths),
        new ClaudeCodeInstallationCleaner(paths),
        new GitHubDesktopInstallationCleaner(paths),
        new DiscordInstallationCleaner(paths),
        new SlackCleaner(paths),
        new SignalRgbCleaner(paths),
        new BalenaEtcherCleaner(paths),
        new T3CodeCleaner(paths),
        new OpenCodeCleaner(paths),
        new ObsidianCleaner(paths),
        new NotionCleaner(paths),
        new ChatboxCleaner(paths),
        new VortexCleaner(paths),
        new LinuaCleaner(paths),
        new NvidiaDriverCleaner(paths),
        new AmdInstallerCleaner(paths)
    ]
}
