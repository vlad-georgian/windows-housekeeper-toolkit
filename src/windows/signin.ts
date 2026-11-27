import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { projectName, readState, stateDirectory, writeState } from '../core/state.ts'
import type { SystemPaths } from '../core/system-paths.ts'
import type { AppCleaner } from '../core/types.ts'
import { registerNotificationIdentity } from './notification.ts'
import { powershellPath, runPowerShell } from './powershell.ts'
import { hasProcessGuard } from './processes.ts'

interface SignInSettings {
    readonly cleanupEnabled: boolean
    readonly cleanupApps: readonly string[]
    readonly enforcementEnabled: boolean
}

const stateFile = 'signin.json'
const entrypoint = fileURLToPath(new URL('../index.ts', import.meta.url))
const help = ['signin status', 'signin cleanup enable --apps ID,ID', 'signin cleanup disable', 'signin enforcement enable|disable']

export function signInLogDirectory(paths: SystemPaths): string {
    return join(stateDirectory(paths), 'logs')
}

export async function readSignInSettings(paths: SystemPaths): Promise<SignInSettings> {
    const saved = await readState<SignInSettings>(paths, stateFile, {
        cleanupEnabled: false,
        cleanupApps: [],
        enforcementEnabled: false
    })
    if (
        !saved ||
        typeof saved.cleanupEnabled !== 'boolean' ||
        typeof saved.enforcementEnabled !== 'boolean' ||
        !Array.isArray(saved.cleanupApps) ||
        !saved.cleanupApps.every((id) => typeof id === 'string') ||
        (saved.cleanupEnabled && saved.cleanupApps.length === 0)
    ) {
        throw new Error('Invalid sign-in settings.')
    }
    return saved
}

export function selectSignInCleaners(cleaners: readonly AppCleaner[], appIds: readonly string[]): AppCleaner[] {
    const byId = new Map(cleaners.map((cleaner) => [cleaner.id, cleaner]))
    return [...new Set(appIds)].map((id) => {
        const cleaner = byId.get(id)
        if (!cleaner || !hasProcessGuard(id)) {
            throw new Error(`"${id}" is unavailable for sign-in cleanup.`)
        }
        return cleaner
    })
}

function quotePowerShell(value: string): string {
    return "'" + value.replaceAll("'", "''") + "'"
}

async function syncTask(mode: 'status' | 'register' | 'remove'): Promise<string> {
    const command = `& ${quotePowerShell(process.execPath)} 'run' ${quotePowerShell(entrypoint)} 'signin' 'run'; exit $LASTEXITCODE`
    const args = '-NoProfile -NoLogo -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(command, 'utf16le').toString('base64')
    return runPowerShell(
        `
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      $name = $data.name + '-' + $identity.User.Value
      $description = 'Runs the configured windows-housekeeper-toolkit jobs in this user session.'
      $service = New-Object -ComObject 'Schedule.Service'
      $service.Connect()
      $folder = $service.GetFolder('\\')
      $task = $null
      try { $task = $folder.GetTask($name) }
      catch { if ($_.Exception.HResult -notin @(-2147024894, -2147024893)) { throw } }
      if ($task -and $task.Definition.RegistrationInfo.Description -cne $description) {
        throw "A task named $name already exists and is not owned by windows-housekeeper-toolkit."
      }
      if ($data.mode -eq 'status') {
        if (-not $task) { 'not registered' }
        elseif (-not $task.Enabled) { 'disabled in Task Scheduler' }
        elseif ($task.Definition.Actions.Item(1).Arguments -cne $data.arguments -or
                $task.Definition.Actions.Item(1).Path -ine $data.shell -or
                $task.Definition.Actions.Item(1).WorkingDirectory -ine $data.directory) {
          'registered with a different Bun or workspace path; rerun enable to refresh it'
        }
        else { 'registered and enabled' }
      } elseif ($data.mode -eq 'remove') {
        if ($task) { $folder.DeleteTask($name, 0) }
      } else {
        $definition = $service.NewTask(0)
        $definition.RegistrationInfo.Description = $description
        $definition.Principal.UserId = $identity.Name
        $definition.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
        $definition.Principal.RunLevel = 0 # TASK_RUNLEVEL_LUA
        $definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
        $definition.Settings.DisallowStartIfOnBatteries = $false
        $definition.Settings.StopIfGoingOnBatteries = $false
        $trigger = $definition.Triggers.Create(9) # TASK_TRIGGER_LOGON
        $trigger.UserId = $identity.Name
        $action = $definition.Actions.Create(0) # TASK_ACTION_EXEC
        $action.Path = $data.shell
        $action.Arguments = $data.arguments
        $action.WorkingDirectory = $data.directory
        # TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN
        $folder.RegisterTaskDefinition($name, $definition, 6, $identity.Name, $null, 3, $null) | Out-Null
      }
    `,
        {
            mode,
            name: projectName,
            shell: powershellPath(),
            arguments: args,
            directory: dirname(dirname(entrypoint))
        }
    )
}

export async function runSignInSettings(paths: SystemPaths, cleaners: readonly AppCleaner[], args: readonly string[]): Promise<void> {
    const [feature, action, flag, value] = args
    if (args.length === 0 || (args.length === 1 && feature === '--help')) {
        console.log(help.join('\n'))
        return
    }
    const saved = await readSignInSettings(paths)
    if (feature === 'status' && args.length === 1) {
        console.log(`Sign-in cleanup ${saved.cleanupEnabled ? 'enabled' : 'disabled'}`)
        console.log(`Selected apps: ${saved.cleanupApps.join(', ') || 'none'}`)
        console.log(`Startup preference enforcement ${saved.enforcementEnabled ? 'enabled' : 'disabled'}`)
        try {
            console.log(`Windows task: ${await syncTask('status')}`)
        } catch (error) {
            console.log(`Windows task status unavailable: ${String(error)}`)
        }
        return
    }

    let next: SignInSettings
    if (feature === 'cleanup' && action === 'enable' && flag === '--apps' && value && args.length === 4) {
        const selected = selectSignInCleaners(
            cleaners,
            value.split(',').map((id) => id.trim())
        )
        await registerNotificationIdentity(paths)
        next = {
            ...saved,
            cleanupEnabled: true,
            cleanupApps: selected.map((cleaner) => cleaner.id)
        }
    } else if (feature === 'cleanup' && action === 'disable' && args.length === 2) {
        next = { ...saved, cleanupEnabled: false }
    } else if (feature === 'enforcement' && (action === 'enable' || action === 'disable') && args.length === 2) {
        next = { ...saved, enforcementEnabled: action === 'enable' }
    } else {
        const ids = cleaners.filter((cleaner) => hasProcessGuard(cleaner.id)).map((cleaner) => cleaner.id)
        throw new Error(`${help.join('\n')}\nAvailable cleanup IDs: ${ids.join(', ')}`)
    }

    await writeState(paths, stateFile, next)
    if (action === 'enable') {
        try {
            await syncTask('register')
        } catch (error) {
            await writeState(paths, stateFile, saved)
            throw error
        }
    } else if (!next.cleanupEnabled && !next.enforcementEnabled) {
        await syncTask('remove')
    }
    console.log(`Sign-in ${feature} ${action}d.`)
}
