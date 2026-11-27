import { runPowerShell } from './powershell.ts'

export interface WindowsProcess {
    readonly id: number
    readonly name: string
    readonly path?: string | null
    readonly commandLine?: string | null
}

export type ProcessLister = () => Promise<readonly WindowsProcess[]>

function isWindowsProcess(value: unknown): value is WindowsProcess {
    return (
        typeof value === 'object' &&
        value !== null &&
        'id' in value &&
        typeof value.id === 'number' &&
        'name' in value &&
        typeof value.name === 'string' &&
        'path' in value &&
        (typeof value.path === 'string' || value.path === null) &&
        'commandLine' in value &&
        (typeof value.commandLine === 'string' || value.commandLine === null)
    )
}

let cimUnavailable = false

export async function listWindowsProcesses(): Promise<WindowsProcess[]> {
    let output: string | undefined
    if (!cimUnavailable) {
        try {
            output = await runPowerShell(
                `
        $items = @(Get-CimInstance Win32_Process -Property ProcessId, Name, ExecutablePath, CommandLine | ForEach-Object {
          @{ id = [int]$_.ProcessId; name = [string]$_.Name; path = $_.ExecutablePath; commandLine = $_.CommandLine }
        })
        ConvertTo-Json -InputObject $items -Compress
      `,
                undefined,
                5_000
            )
        } catch {
            cimUnavailable = true
        }
    }
    output ??= await runPowerShell(
        `
      $items = @(Get-Process | ForEach-Object {
        @{ id = [int]$_.Id; name = $_.ProcessName + '.exe'; path = $_.Path; commandLine = $null }
      })
      ConvertTo-Json -InputObject $items -Compress
  `,
        undefined,
        5_000
    )
    const processes: unknown = JSON.parse(output)
    if (!Array.isArray(processes) || !processes.every(isWindowsProcess) || processes.length === 0) {
        throw new Error('Windows did not return a valid running process inventory.')
    }
    return processes
}

// Include updater and companion processes that can write into the selected app's caches.
const processNames: Readonly<Record<string, RegExp>> = {
    'signal-rgb': /^(signalrgb|vortxengine|signalrgblauncher|signalrgbcore)([ ._-]|$)/i,
    vortex: /^vortex([ ._-]|$)/i,
    't3-code': /^t3[ -]?code([ ._-]|$)/i,
    obsidian: /^obsidian([ ._-]|$)/i,
    'github-desktop': /^githubdesktop([ ._-]|$)/i,
    notion: /^notion([ ._-]|$)/i,
    chatbox: /^chatbox([ ._-]|$)/i,
    'claude-code': /^claude([ ._-]|$)/i,
    'claude-desktop': /^claude([ ._-]|$)/i,
    codex: /^(codex|chatgpt)([ ._-]|$)/i,
    'npm-cache': /^(node|npm|npx)([ ._-]|$)/i,
    'scoop-relocation': /^scoop([ ._-]|$)/i,
    'vite-plus-relocation': /^(vp|vpx|vpr|node|npm|npx|bun|bunx|pnpm|yarn)([ ._-]|$)/i,
    'bun-relocation': /^(bun|bunx)([ ._-]|$)/i,
    'nuget-cache': /^(nuget|choco|dotnet|msbuild|devenv)([ ._-]|$)/i,
    'chocolatey-cache': /^choco([ ._-]|$)/i,
    'amd-installers': /^(setup|amdsoftwareinstaller|amd-software|radeoninstaller|amdcleanuputility)([ ._-]|$)/i,
    discord: /^discord([ ._-]|canary|ptb|$)/i,
    slack: /^slack([ ._-]|$)/i,
    'balena-etcher': /^balenaetcher([ ._-]|$)/i,
    linua: /^linua([ ._-]|$)/i,
    opencode: /^(opencode|open code)([ ._-]|$)/i,
    vscode: /^code([ ._-]|$)/i
}

const processLocations: Readonly<Record<string, RegExp>> = {
    'signal-rgb': /[\\/](signalrgb|vortxengine)([\\/]|$)/i,
    'github-desktop': /[\\/]githubdesktop[\\/]/i,
    discord: /[\\/]discord(?:canary|ptb)?[\\/]/i,
    slack: /[\\/]slack[\\/]/i,
    'balena-etcher': /[\\/]balenaetcher[\\/]/i,
    't3-code': /[\\/](?:t3code(?:-updater)?|\.t3)[\\/]/i,
    'claude-code': /[\\/]claude(?:-code)?[\\/]/i,
    codex: /[\\/](codex|\.codex)[\\/]/i,
    opencode: /[\\/](ai\.opencode\.desktop|@opencodedesktop-updater|opencode)[\\/]/i
}

const commandLineApps = new Set(['t3-code', 'claude-code', 'codex', 'opencode'])

export function hasProcessGuard(appId: string): boolean {
    return Object.hasOwn(processNames, appId)
}

export function isAppRunning(appId: string, processes: readonly WindowsProcess[]): boolean {
    const names = processNames[appId]
    if (!names) throw new Error(`No running-app check is available for "${appId}".`)
    const location = processLocations[appId]
    return processes.some((entry) => {
        if (entry.id === process.pid) return false
        return (
            names.test(entry.name) ||
            Boolean(entry.path && location?.test(entry.path)) ||
            Boolean(/^(bun|node|update|squirrel)\.exe$/i.test(entry.name) && (entry.commandLine ? location?.test(entry.commandLine) : commandLineApps.has(appId)))
        )
    })
}
