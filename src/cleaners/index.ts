import type { SystemPaths } from '../core/system-paths.ts'
import type { AppCleaner } from '../core/types.ts'
import { AmdInstallerCleaner } from './amd-installer-cleaner.ts'
import { BalenaEtcherCleaner } from './balena-etcher-cleaner.ts'
import { ChatboxCleaner } from './chatbox-cleaner.ts'
import { ClaudeCodeCleaner } from './claude-code-cleaner.ts'
import { ClaudeDesktopCleaner } from './claude-desktop-cleaner.ts'
import { CodexCleaner } from './codex-cleaner.ts'
import { DiscordCleaner } from './discord-cleaner.ts'
import { GitHubDesktopCleaner } from './github-desktop-cleaner.ts'
import { LinuaCleaner } from './linua-cleaner.ts'
import { NotionCleaner } from './notion-cleaner.ts'
import { NpmCacheCleaner } from './npm-cache-cleaner.ts'
import { NugetCacheCleaner } from './nuget-cache-cleaner.ts'
import { NvidiaDriverCleaner } from './nvidia-driver-cleaner.ts'
import { ObsidianCleaner } from './obsidian-cleaner.ts'
import { OpenCodeCleaner } from './opencode-cleaner.ts'
import { SignalRgbCleaner } from './signal-rgb-cleaner.ts'
import { SlackCleaner } from './slack-cleaner.ts'
import { T3CodeCleaner } from './t3-code-cleaner.ts'
import { VortexCleaner } from './vortex-cleaner.ts'
import { VSCodeCleaner } from './vscode-cleaner.ts'

export function createCleaners(paths: SystemPaths): readonly AppCleaner[] {
    return [
        new SignalRgbCleaner(paths),
        new VortexCleaner(paths),
        new T3CodeCleaner(paths),
        new OpenCodeCleaner(paths),
        new VSCodeCleaner(paths),
        new ObsidianCleaner(paths),
        new GitHubDesktopCleaner(paths),
        new NotionCleaner(paths),
        new ChatboxCleaner(paths),
        new ClaudeCodeCleaner(paths),
        new ClaudeDesktopCleaner(paths),
        new CodexCleaner(paths),
        new NvidiaDriverCleaner(paths),
        new NpmCacheCleaner(paths),
        new NugetCacheCleaner(paths),
        new AmdInstallerCleaner(paths),
        new DiscordCleaner(paths),
        new SlackCleaner(paths),
        new BalenaEtcherCleaner(paths),
        new LinuaCleaner(paths)
    ]
}
