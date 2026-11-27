import {
    type AppId,
    type AppInventory,
    isAppId,
    isArrayOf,
    isRecord,
    isString,
    parseInventoryResult,
    scheduledTaskScript,
} from "../app-catalog.ts";
import { runPowerShell } from "../powershell.ts";
import { directTargetScript } from "./registry.ts";

interface StartupEntry {
    app: AppId;
    name: string;
    source: string;
    state: string;
    target: string;
    command: string;
    valueKind: string;
    supported: boolean;
}

interface StartupInventory {
    entries: StartupEntry[];
    warnings: string[];
}

function isStartupEntry(value: unknown): value is StartupEntry {
    return (
        isRecord(value) &&
        isAppId(value.app) &&
        isString(value.name) &&
        isString(value.source) &&
        isString(value.state) &&
        isString(value.target) &&
        isString(value.command) &&
        isString(value.valueKind) &&
        typeof value.supported === "boolean"
    );
}

function isStartupInventory(value: unknown): value is StartupInventory {
    return (
        isRecord(value) &&
        isArrayOf(value.entries, isStartupEntry) &&
        isArrayOf(value.warnings, isString)
    );
}

export async function getStartupEntries(inventory: AppInventory): Promise<StartupInventory> {
    const output = await runPowerShell(
        String.raw`
    ${directTargetScript}
    function Find-App([string] $target) {
      $data.installs | Where-Object path -EQ $target | Select-Object -First 1
    }
    $warnings = [Collections.Generic.List[string]]::new()
    $entries = @(
      $views = @('Default')
      if ([Environment]::Is64BitOperatingSystem) { $views = @('Registry64', 'Registry32') }
      $locations = @(@{ hive = 'CurrentUser'; view = 'Default'; label = 'HKCU' })
      foreach ($view in $views) {
        $locations += @{ hive = 'LocalMachine'; view = $view; label = "HKLM ($view)" }
      }
      foreach ($location in $locations) {
        foreach ($keyName in 'Run', 'RunOnce') {
          $source = "$($location.label) $keyName"
          $base = $null
          $key = $null
          try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($location.hive, $location.view)
            $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\' + $keyName)
            if ($null -eq $key) { continue }
            foreach ($name in $key.GetValueNames()) {
              $kind = [string]$key.GetValueKind($name)
              if ($kind -notin @('String', 'ExpandString')) { continue }
              $command = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
              $expanded = if ($kind -eq 'ExpandString') { [Environment]::ExpandEnvironmentVariables($command) } else { $command }
              $target = Get-DirectTarget $expanded
              $app = Find-App $target
              if ($null -eq $app) { continue }
              $state = if ($keyName -eq 'RunOnce') { 'registered to run once' } else { 'registered; see Startup Apps for approval' }
              [pscustomobject]@{ app = $app.id; name = $name; source = $source; state = $state; target = $target;
                command = $command; valueKind = $kind; supported = $source -eq 'HKCU Run' -and $name.Length -gt 0 -and (Test-UnlinkedExecutable $target) }
            }
          } catch { $warnings.Add("Could not inspect $($source): $($_.Exception.Message)") }
          finally {
            if ($null -ne $key) { $key.Close() }
            if ($null -ne $base) { $base.Close() }
          }
        }
      }
      foreach ($folder in 'Startup', 'CommonStartup') {
        try {
          $path = [Environment]::GetFolderPath($folder)
          if (-not $path) { continue }
          $shell = New-Object -ComObject WScript.Shell
          foreach ($file in Get-ChildItem -LiteralPath $path -File) {
            $target = switch ($file.Extension) {
              '.lnk' { $shell.CreateShortcut($file.FullName).TargetPath }
              '.exe' { $file.FullName }
            }
            $app = Find-App $target
            if ($null -eq $app) { continue }
            [pscustomobject]@{ app = $app.id; name = $file.Name; source = $folder; state = 'present; see Startup Apps for approval'; target = $target; command = ''; valueKind = ''; supported = $false }
          }
        } catch { $warnings.Add("Could not inspect $folder folder: $($_.Exception.Message)") }
      }
    )
    [pscustomobject]@{ entries = $entries; warnings = $warnings } | ConvertTo-Json -Depth 5 -Compress
  `,
        { installs: inventory.installs },
        10_000,
    );
    return parseInventoryResult(output, isStartupInventory);
}

export async function getScheduledStartupEntries(
    inventory: AppInventory,
): Promise<StartupInventory> {
    try {
        const output = await runPowerShell(
            String.raw`
      ${scheduledTaskScript}
      $warnings = [Collections.Generic.List[string]]::new()
      $states = @('Unknown', 'Disabled', 'Queued', 'Ready', 'Running')
      $entries = @(
        foreach ($task in Get-VisibleTasks) {
          try {
            $definition = $task.Definition
            $logon = @($definition.Triggers | Where-Object Type -EQ 9)
            if ($logon.Count -eq 0) { continue }
            foreach ($action in $definition.Actions) {
              if ($action.Type -ne 0 -or -not $action.Path) { continue }
              $target = [Environment]::ExpandEnvironmentVariables($action.Path).Trim('"')
              $app = $data.installs | Where-Object path -EQ $target | Select-Object -First 1
              if ($null -eq $app) { continue }
              $state = if ($logon | Where-Object Enabled) { $states[$task.State] } else { 'logon triggers disabled' }
              [pscustomobject]@{ app = $app.id; name = [string]$task.Path; source = 'Scheduled task'; state = [string]$state; target = $target; command = ''; valueKind = ''; supported = $false }
            }
          } catch { $warnings.Add('At least one scheduled task definition could not be inspected.') }
        }
      )
      [pscustomobject]@{ entries = $entries; warnings = @($warnings | Select-Object -Unique) } | ConvertTo-Json -Depth 5 -Compress
    `,
            { installs: inventory.installs },
            10_000,
        );
        return parseInventoryResult(output, isStartupInventory);
    } catch (error) {
        return {
            entries: [],
            warnings: [
                `Could not inspect scheduled logon tasks: ${error instanceof Error ? error.message : String(error)}`,
            ],
        };
    }
}
