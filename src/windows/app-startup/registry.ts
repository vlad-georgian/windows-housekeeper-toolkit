import type { AppInventory } from "../app-catalog.ts";
import { runPowerShell } from "../powershell.ts";
import type { StartupPreference } from "./preferences.ts";

export const directTargetScript = String.raw`
  function Get-DirectTarget([string] $command) {
    if ($command -match '^\s*"([^"\r\n]+)"(?:\s|$)') { $target = $Matches[1] }
    elseif ($command -match '^\s*([^\s"]+)(?:\s|$)') { $target = $Matches[1] }
    else { return }
    if ($target -notmatch '^[A-Z]:\\[^\r\n]*\.exe$') { return }
    [IO.Path]::GetFullPath($target)
  }
  function Test-UnlinkedExecutable([string] $target) {
    $item = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.PSIsContainer) { return $false }
    while ($null -ne $item) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
      $item = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    }
    $true
  }
`;

export async function changeRunValue(
    inventory: AppInventory,
    preference: StartupPreference,
    restore: boolean,
): Promise<"changed" | "unchanged"> {
    const installs = inventory.installs.filter((install) => install.id === preference.app);
    const output = await runPowerShell(
        String.raw`
    ${directTargetScript}
    $pref = $data.preference
    $path = 'Software\Microsoft\Windows\CurrentVersion\Run'
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)
    try {
      $current = if ($null -ne $key) { $key.GetValue($pref.name, $null, 'DoNotExpandEnvironmentNames') }
      if ($null -ne $current -and ([string]$key.GetValueKind($pref.name) -cne $pref.valueKind -or $current -cne $pref.command)) {
        throw 'A different command now uses this HKCU Run value.'
      }
      if (($data.restore -and $null -ne $current) -or (-not $data.restore -and $null -eq $current)) {
        'unchanged'
        return
      }
      $command = if ($pref.valueKind -eq 'ExpandString') { [Environment]::ExpandEnvironmentVariables($pref.command) } else { $pref.command }
      $target = Get-DirectTarget $command
      if (-not $target -or $target -ne $pref.target -or $target -notin $data.installPaths) {
        throw 'The saved command no longer resolves to the verified installation.'
      }
      if (-not (Test-UnlinkedExecutable $target)) { throw 'The startup target is missing or has a linked path component.' }
      if ($data.restore) {
        if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path) }
        if ($null -ne $key.GetValue($pref.name, $null, 'DoNotExpandEnvironmentNames')) {
          throw 'The HKCU Run value appeared during the restore.'
        }
        $key.SetValue($pref.name, $pref.command, $pref.valueKind)
        if ([string]$key.GetValueKind($pref.name) -cne $pref.valueKind -or
            $key.GetValue($pref.name, $null, 'DoNotExpandEnvironmentNames') -cne $pref.command) { throw 'Could not verify the restored startup entry.' }
      } else {
        if ([string]$key.GetValueKind($pref.name) -cne $pref.valueKind -or
            $key.GetValue($pref.name, $null, 'DoNotExpandEnvironmentNames') -cne $pref.command) { throw 'The startup entry changed during inspection.' }
        $key.DeleteValue($pref.name, $true)
        if ($null -ne $key.GetValue($pref.name, $null, 'DoNotExpandEnvironmentNames')) { throw 'Could not verify the startup entry was disabled.' }
      }
      'changed'
    } finally { if ($null -ne $key) { $key.Close() } }
  `,
        { preference, restore, installPaths: installs.map((install) => install.path) },
    );
    if (output !== "changed" && output !== "unchanged")
        throw new Error("Unexpected startup change result.");
    return output;
}
