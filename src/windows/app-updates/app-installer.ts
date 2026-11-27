import {
    type AppInventory,
    isArrayOf,
    isRecord,
    isString,
    parseInventoryResult,
} from "../app-catalog.ts";
import { runPowerShell } from "../powershell.ts";

interface AppInstallerStatus {
    package: string;
    state: string;
    manageable: boolean;
}

function isAppInstallerStatus(value: unknown): value is AppInstallerStatus {
    return (
        isRecord(value) &&
        isString(value.package) &&
        isString(value.state) &&
        typeof value.manageable === "boolean"
    );
}

// Cmdlet signatures differ across Windows releases. Only allow a setter that accepts
// the background flag by itself, and compare the effective package settings afterward.
const appInstallerScript = String.raw`
  function Get-Installer($fullName, $family) {
    $getter = Get-Command Get-AppxPackageAutoUpdateSettings
    $filter = if ($getter.Parameters.ContainsKey('PackageFamilyName')) { @{ PackageFamilyName = $family } }
      elseif ($getter.Parameters.ContainsKey('PackageFullName')) { @{ PackageFullName = $fullName } }
      else { throw 'The Appx settings getter has no package-specific parameter.' }
    $rows = @(Get-AppxPackageAutoUpdateSettings @filter)
    if ($rows.Count -eq 0) { return }
    if ($rows.Count -ne 1 -or $rows[0].PackageFullName -ne $fullName -or $rows[0].PackageFamilyName -ne $family) {
      throw 'Windows did not return settings uniquely scoped to the current-user package.'
    }
    $rows[0]
  }
  function Get-UriStrings($uris) {
    foreach ($uri in $uris) {
      if ($uri -isnot [Uri] -or -not $uri.IsAbsoluteUri) { throw 'An App Installer source URI could not be verified.' }
      $uri.AbsoluteUri
    }
  }
  function Get-Settings($info) {
    if ($null -eq $info) { throw 'This package has no App Installer settings.' }
    $fields = @('PolicySource', 'CheckForUpdatesOnLaunch', 'AutomaticBackgroundTaskUpdatesEnabled', 'IsAutoRepairEnabled',
      'ShowPromptOnLaunchWhenUpdateIsAvailable', 'ForceUpdateFromAnyVersion', 'UpdateBlocksActivation',
      'HoursBetweenUpdateChecks', 'Version', 'UpdateUris', 'RepairUris', 'OptionalPackageUris',
      'DependencyPackageUris', 'AppInstallerUri', 'PausedUntil')
    foreach ($field in $fields) {
      if ($null -eq $info.PSObject.Properties[$field]) { throw 'Windows did not expose the complete App Installer settings.' }
    }
    [pscustomobject][ordered]@{
      Source = [string]$info.PolicySource
      Background = $info.AutomaticBackgroundTaskUpdatesEnabled
      OnLaunch = $info.CheckForUpdatesOnLaunch
      IsAutoRepairEnabled = $info.IsAutoRepairEnabled
      ShowPrompt = $info.ShowPromptOnLaunchWhenUpdateIsAvailable
      ForceUpdateFromAnyVersion = $info.ForceUpdateFromAnyVersion
      UpdateBlocksActivation = $info.UpdateBlocksActivation
      HoursBetweenUpdateChecks = $info.HoursBetweenUpdateChecks
      Uri = $info.AppInstallerUri
      PausedUntil = if ($null -ne $info.PausedUntil) { ([DateTimeOffset]$info.PausedUntil).ToString('o') } else { $null }
      Version = $info.Version
      UpdateUris = @(Get-UriStrings $info.UpdateUris)
      RepairUris = @(Get-UriStrings $info.RepairUris)
      OptionalPackages = @(Get-UriStrings $info.OptionalPackageUris)
      DependencyPackages = @(Get-UriStrings $info.DependencyPackageUris)
    }
  }
  function Get-BlockReason($settings) {
    if ($settings.Source -ne 'Default') { return 'controlled by Windows system policy' }
    if ($settings.PausedUntil) { return 'an update pause is recorded' }
    if (-not $settings.OnLaunch) { return 'launch-time update checking is off' }
    if (-not [Uri]::IsWellFormedUriString($settings.Uri, 'Absolute')) { return 'the installer source URI is unverified' }
    $setter = Get-Command Set-AppxPackageAutoUpdateSettings -ErrorAction SilentlyContinue
    if ($null -eq $setter -or $setter.Parameters['EnableAutomaticBackgroundTask'].ParameterType -ne [bool]) {
      return 'Windows does not expose a background-only Appx setting'
    }
    $sets = @($setter.ParameterSets | Where-Object {
      $_.Parameters.Name -contains 'PackageFamilyName' -and $_.Parameters.Name -contains 'EnableAutomaticBackgroundTask' -and
      -not ($_.Parameters | Where-Object { $_.IsMandatory -and $_.Name -ne 'PackageFamilyName' })
    })
    if ($sets.Count -ne 1) { return 'Windows does not expose a background-only Appx setting' }
  }
`;

export async function getAppInstallerStatus(
    inventory: AppInventory,
): Promise<AppInstallerStatus[]> {
    const packages = inventory.packages.filter(
        (item) => item.registered && item.signature !== "Store",
    );
    if (packages.length === 0) return [];
    try {
        const output = await runPowerShell(
            String.raw`
    ${appInstallerScript}
    $results = @(
      foreach ($item in $data.packages) {
        $manageable = $false
        try {
          $info = Get-Installer $item.fullName $item.family
          if ($null -eq $info) { $state = 'No Windows App Installer settings registered.' }
          else {
            $settings = Get-Settings $info
            $background = if ($settings.Background) { 'on' } else { 'off' }
            $launch = if ($settings.OnLaunch) { 'on' } else { 'off' }
            $state = "App Installer background checks $background; launch-time checks $launch."
            $reason = Get-BlockReason $settings
            if ($reason) { $state += " Read-only: $reason." }
            else { $manageable = $true }
          }
        } catch { $state = "App Installer mechanism unverified: $($_.Exception.Message)" }
        [pscustomobject]@{ package = $item.fullName; state = $state; manageable = $manageable }
      }
    )
    ConvertTo-Json -InputObject $results -Depth 4 -Compress
  `,
            { packages },
            10_000,
        );
        return parseInventoryResult(output, (value) => isArrayOf(value, isAppInstallerStatus));
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return packages.map((item) => ({
            package: item.fullName,
            state: `App Installer mechanism unverified: ${detail}`,
            manageable: false,
        }));
    }
}

export async function disablePackageBackgroundUpdates(
    selected: AppInventory["packages"][number],
): Promise<"already-off" | "disabled"> {
    const output = await runPowerShell(
        String.raw`
    ${appInstallerScript}
    function Set-Background([bool] $enabled) {
      Set-AppxPackageAutoUpdateSettings -PackageFamilyName $data.family -EnableAutomaticBackgroundTask $enabled -Confirm:$false | Out-Null
    }
    function Get-CurrentSettings { Get-Settings (Get-Installer $data.fullName $data.family) }
    function Get-Snapshot($settings) { ConvertTo-Json -InputObject $settings -Depth 5 -Compress }

    $matches = @(Get-AppxPackage -Name $data.name -PackageTypeFilter Main | Where-Object PackageFamilyName -EQ $data.family)
    if ($matches.Count -ne 1 -or $matches[0].PackageFullName -ne $data.fullName -or $matches[0].SignatureKind -eq 'Store') {
      throw 'The verified package registration changed.'
    }
    $before = Get-CurrentSettings
    $reason = Get-BlockReason $before
    if ($reason) { throw "The package update configuration is read-only: $reason." }
    if (-not $before.Background) { 'already-off'; return }
    $original = Get-Snapshot $before
    $desired = ConvertFrom-Json -InputObject $original
    $desired.Background = $false
    try {
      Set-Background $false
      $current = Get-CurrentSettings
      if ((Get-Snapshot $current) -cne (Get-Snapshot $desired)) { throw 'The effective settings differed from the requested settings.' }
      'disabled'
    } catch {
      $failure = $_.Exception.Message
      try {
        $current = Get-CurrentSettings
        if ((Get-Snapshot $current) -cne $original) {
          if ($current.Source -ne 'Default' -or $current.Uri -cne $before.Uri) { throw 'The policy source or installer URI changed.' }
          if ($current.Background -ne $before.Background) { Set-Background $before.Background }
          if ((Get-Snapshot (Get-CurrentSettings)) -cne $original) { throw 'Could not verify the original settings.' }
        }
      } catch { throw "Could not verify the update change ($failure). Could not restore the original settings: $($_.Exception.Message)" }
      throw "Could not verify the update change ($failure). The original settings are in effect."
    }
  `,
        {
            family: selected.family,
            fullName: selected.fullName,
            name: selected.fullName.split("_")[0],
        },
    );
    if (output !== "already-off" && output !== "disabled")
        throw new Error("Unexpected App Installer settings result.");

    return output;
}
