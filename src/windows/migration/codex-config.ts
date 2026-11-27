import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { SystemPaths } from '../../core/system-paths.ts'
import { runPowerShell } from '../powershell.ts'
import { verifyCodexEnvironment } from './codex-environment.ts'
import { plainFile } from './files.ts'

export const codexLogDocumentation = 'https://developers.openai.com/codex/config-reference#log_dir'

function redirectLine(destination: string, operationId: string): string {
    return `log_dir = ${JSON.stringify(destination)} # windows-housekeeper-toolkit ${operationId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readToml(contents: string, path: string): Record<string, unknown> {
    try {
        const parsed = Bun.TOML.parse(contents.replace(/^\uFEFF/u, ''))
        if (isRecord(parsed)) return parsed
    } catch {
        // The parser's error can quote protected config values.
    }
    throw new Error(`Could not parse the Codex settings at ${path}.`)
}

export async function codexConfiguration(path: string): Promise<{ text: string | null; settings: Record<string, unknown> }> {
    const text = (await plainFile(path)) ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path)) : null
    return { text, settings: readToml(text ?? '', path) }
}

function redirectsLogs(value: unknown): boolean {
    return isRecord(value) && (Object.hasOwn(value, 'log_dir') || Object.hasOwn(value, 'sqlite_home'))
}

export async function verifyCodexConfiguration(paths: SystemPaths, home: string, expectedLogDir: string | null, operationId?: string): Promise<void> {
    const config = join(home, 'config.toml')
    const { settings, text } = await codexConfiguration(config)
    if (settings.sqlite_home !== undefined || (settings.log_dir ?? null) !== expectedLogDir) {
        throw new Error(`The Codex log or SQLite setting changed at ${config}.`)
    }
    if (
        expectedLogDir &&
        operationId &&
        !text
            ?.replace(/^\uFEFF/u, '')
            .split(/\r?\n/u)
            .includes(redirectLine(expectedLogDir, operationId))
    ) {
        throw new Error(`The log_dir setting was edited outside this migration at ${config}.`)
    }

    const systemConfig = join(paths.programData, 'OpenAI', 'Codex', 'config.toml')
    const system = await codexConfiguration(systemConfig)
    const profiles = settings.profiles
    if (redirectsLogs(system.settings) || (profiles && typeof profiles === 'object' && Object.values(profiles).some(redirectsLogs))) {
        throw new Error('A system setting or Codex profile overrides the diagnostic log location.')
    }
    for (const name of await readdir(home)) {
        if (name.toLowerCase().endsWith('.config.toml') && redirectsLogs((await codexConfiguration(join(home, name))).settings)) {
            throw new Error(`Codex profile ${name} overrides the diagnostic log location.`)
        }
    }

    await verifyCodexEnvironment(paths, home)
}

export async function updateCodexLogSetting(configPath: string, destination: string, operationId: string, restore: boolean): Promise<void> {
    const { text, settings } = await codexConfiguration(configPath)
    const line = redirectLine(destination, operationId)
    const content = text ?? ''
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
    const lines = content.slice(bom.length).split(/(?<=\n)/u)
    const owned = lines.filter((entry) => entry.replace(/\r?\n$/u, '') === line)
    const { log_dir: current, ...otherSettings } = settings

    if (restore && current === undefined) return
    if (!restore && current === destination && owned.length === 1) return
    if (restore ? current !== destination || owned.length !== 1 : current !== undefined) {
        throw new Error(`The log_dir setting was edited outside this migration at ${configPath}.`)
    }

    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const changed = restore ? bom + lines.filter((entry) => entry !== owned[0]).join('') : bom + line + newline + content.slice(bom.length)
    const expectedSettings = restore ? otherSettings : { ...settings, log_dir: destination }
    if (!isDeepStrictEqual(readToml(changed, configPath), expectedSettings)) {
        throw new Error('The proposed log_dir edit affects other Codex settings.')
    }

    await runPowerShell(
        `
    $path = [string]$data.path
    $temporary = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
      [IO.File]::Open($temporary, [IO.FileMode]::CreateNew).Dispose()
      if ($null -ne $data.before) {
        $original = Get-Item -LiteralPath $path -Force
        if ($original.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          throw 'The Codex configuration became a link.'
        }
        [IO.File]::SetAccessControl($temporary, [IO.File]::GetAccessControl($path))
      }
      [IO.File]::WriteAllBytes($temporary, [Convert]::FromBase64String($data.after))
      if ($null -eq $data.before) {
        [IO.File]::Move($temporary, $path)
      } else {
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne $data.before) {
          throw 'The Codex configuration changed during the edit.'
        }
        [IO.File]::Replace($temporary, $path, [NullString]::Value)
      }
    } finally {
      if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
  `,
        {
            path: configPath,
            before: text === null ? null : Buffer.from(text).toString('base64'),
            after: Buffer.from(changed).toString('base64')
        }
    )
}
