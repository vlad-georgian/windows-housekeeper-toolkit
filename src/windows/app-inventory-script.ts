export const appInventoryScript = String.raw`
    $warnings = [Collections.Generic.List[string]]::new()
    $installs = @(
      foreach ($install in $data.installs) {
        $file = Get-Item -LiteralPath $install.path -ErrorAction SilentlyContinue
        if ($null -eq $file -or $file.PSIsContainer) { continue }
        if ($install.product -and ($file.VersionInfo.ProductName -ne $install.product -or
            $file.VersionInfo.CompanyName -ne $install.publisher)) {
          $warnings.Add("Could not verify the executable identity at $($install.path).")
          continue
        }
        $install | Select-Object id, type, path
      }
      if (Test-Path -LiteralPath $data.npmPackage -PathType Leaf) {
        try {
          $npm = Get-Content -LiteralPath $data.npmPackage -Raw | ConvertFrom-Json
          if ($npm.name -eq '@openai/codex') {
            [pscustomobject]@{ id = 'codex'; type = 'npm CLI through Scoop'; path = Split-Path $data.npmPackage }
          }
        } catch { $warnings.Add('Could not read the Codex npm package metadata.') }
      }
    )
    $services = @()
    $servicePackages = @{}
    foreach ($identity in $data.services) {
      try {
        $service = Get-Service -Name $identity.name -ErrorAction SilentlyContinue
        if ($null -eq $service) { continue }
        $config = Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $identity.name)
        $image = [Environment]::ExpandEnvironmentVariables($config.ImagePath).Trim('"')
        $package = $data.packages | Where-Object id -EQ $identity.id
        $packagePattern = [regex]::Escape($package.name) + '_[\d.]+_[a-z0-9]+__' + [regex]::Escape(($package.family -split '_')[-1])
        $servicePattern = '^(?<location>[A-Z]:\\[^"\r\n]+\\WindowsApps\\(?<package>' + $packagePattern + '))\\app\\resources\\' + [regex]::Escape($identity.file) + '$'
        if ($image -notmatch $servicePattern) {
          $warnings.Add("Could not verify ownership of service $($identity.name).")
          continue
        }
        $servicePackages[$identity.id] = @{ location = $Matches.location; fullName = $Matches.package }
        $services += [pscustomobject]@{ id = $identity.id; name = $service.Name; status = [string]$service.Status; start = [string]$service.StartType }
      } catch { $warnings.Add("Could not inspect service $($identity.name): $($_.Exception.Message)") }
    }
    $packages = @(
      foreach ($identity in $data.packages) {
        try {
          $registered = @(Get-AppxPackage -Name $identity.name -PackageTypeFilter Main | Where-Object PackageFamilyName -EQ $identity.family)
        } catch {
          $warnings.Add("Could not query current-user registration for $($identity.family): $($_.Exception.Message)")
          $registered = @()
        }
        $matchesForApp = @(foreach ($package in $registered) {
          @{ location = $package.InstallLocation; fullName = $package.PackageFullName; registered = $true; signature = [string]$package.SignatureKind }
        })
        if ($matchesForApp.Count -eq 0 -and $servicePackages.ContainsKey($identity.id)) {
          $matchesForApp = @($servicePackages[$identity.id])
        }
        foreach ($package in $matchesForApp) {
          $tasks = @()
          try {
            if ($package.registered) {
              $manifest = Get-AppxPackageManifest -Package $package.fullName
            } else {
              $manifest = [xml](Get-Content -LiteralPath (Join-Path $package.location 'AppxManifest.xml') -Raw)
            }
            if ($manifest.Package.Identity.Name -ne $identity.name) { throw 'Package identity mismatch.' }
            $tasks = @(
              foreach ($task in $manifest.SelectNodes('//*[local-name()="Extension" and @Category="windows.startupTask"]/*[local-name()="StartupTask"]')) {
                [pscustomobject]@{ name = $task.GetAttribute('TaskId'); label = $task.GetAttribute('DisplayName') }
              }
            )
          } catch { $warnings.Add("Could not read startup declarations for $($identity.family): $($_.Exception.Message)") }
          [pscustomobject]@{
            id = $identity.id; family = $identity.family; fullName = $package.fullName
            location = $package.location; registered = [bool]$package.registered; signature = [string]$package.signature; tasks = $tasks
          }
        }
      }
    )
    [pscustomobject]@{ installs = $installs; packages = $packages; services = $services; warnings = $warnings } | ConvertTo-Json -Depth 6 -Compress
  `
