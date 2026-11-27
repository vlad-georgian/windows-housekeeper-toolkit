import { unlinkedExecutableScript } from '../app-startup/registry.ts'
import { serviceConfigInterop } from './scm.ts'

export const appServiceScript = String.raw`
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      if ($data.expected) { throw 'Administrator elevation is required to change app service startup.' }
      '{"elevated":false,"services":[],"warnings":[]}'
      return
    }

    Add-Type -TypeDefinition @'
${serviceConfigInterop}
'@
    ${unlinkedExecutableScript}

    function Get-StartupMode($handle, $config) {
      switch ($config.Start) {
        2 { if ([Housekeeper.ServiceConfig]::IsDelayed($handle)) { 'Automatic (Delayed Start)' } else { 'Automatic' } }
        3 { 'Manual' }
        4 { 'Disabled' }
        default { throw 'Unsupported service startup mode.' }
      }
    }

    function Assert-SameConfig($config, $snapshot) {
      if ($config.Type -ne 0x210 -or $config.Account -ne 'LocalSystem' -or $config.ImagePath -cne $snapshot.imagePath) {
        throw 'The service configuration changed during verification.'
      }
    }

    function Get-VerifiedService($identity, $handle) {
      $config = [Housekeeper.ServiceConfig]::Read($handle)
      if ($config.Type -ne 0x210 -or $config.Account -ne 'LocalSystem') {
        throw 'Expected a packaged, own-process service running as LocalSystem.'
      }

      $relative = 'app\resources\' + $identity.file
      $packages = @(Get-AppxPackage -AllUsers -Name $identity.package.name -PackageTypeFilter Main | Where-Object {
        $_.PackageFamilyName -eq $identity.package.family -and $_.Status -eq 'Ok' -and
          $_.SignatureKind -in @('Store', 'Developer') -and $_.PackageUserInformation.InstallState -contains 'Installed' -and $_.InstallLocation
      } | Where-Object {
        # The full, quoted command must point directly to the exact installed package's executable.
        $target = Join-Path $_.InstallLocation $relative
        $config.ImagePath -eq ('"' + $target + '"') -or ($target -notmatch '\s' -and $config.ImagePath -eq $target)
      })
      if ($packages.Count -ne 1) { throw 'The service command does not match one installed package.' }
      $package = $packages[0]

      $installedFor = $package.PackageUserInformation | Where-Object InstallState -EQ 'Installed' | Select-Object -First 1
      $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -User $installedFor.UserSecurityId
      $ns = [Xml.XmlNamespaceManager]::new($manifest.NameTable)
      $ns.AddNamespace('d', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/6')
      $declared = @($manifest.SelectNodes('//d:Extension[@Category="windows.service"]/d:Service', $ns) | Where-Object {
        $_.GetAttribute('Name') -eq $identity.name -and $_.GetAttribute('StartAccount') -eq 'localSystem' -and -not $_.GetAttribute('Arguments') -and
          $_.ParentNode.GetAttribute('Executable').Replace('/', '\') -eq $relative
      })
      if ($declared.Count -ne 1) { throw 'The installed package does not declare the expected service and executable.' }

      $target = Join-Path $package.InstallLocation $relative
      if (-not (Test-UnlinkedExecutable $target)) { throw 'The service executable is unavailable or has a linked path component.' }
      $signature = Get-AuthenticodeSignature -LiteralPath $target
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -cne $identity.signer) {
        throw 'The service executable does not have the expected valid publisher signature.'
      }
      $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
      [pscustomobject]@{ app = $identity.id; name = $identity.name; packageFullName = $package.PackageFullName;
        imagePath = $config.ImagePath; binaryHash = $hash; mode = Get-StartupMode $handle $config }
    }

    if ($data.expected) {
      $expected = $data.expected
      $handle = $null
      try {
        try {
          $identity = $data.identities | Where-Object { $_.id -ceq $expected.app -and $_.name -ceq $expected.name }
          if (-not $identity) { throw 'This service is outside the app service startup catalog.' }
          $handle = [Housekeeper.ServiceConfig]::Open($identity.name)
          if ($null -eq $handle) { throw 'The service is no longer registered.' }
          $service = Get-VerifiedService $identity $handle
          if ($service.packageFullName -cne $expected.packageFullName -or $service.imagePath -cne $expected.imagePath -or
              $service.binaryHash -cne $expected.binaryHash -or $service.mode -cne $expected.mode) {
            throw 'The service identity or startup mode changed since the plan was shown.'
          }
          $config = [Housekeeper.ServiceConfig]::Read($handle)
          Assert-SameConfig $config $expected
          if ((Get-StartupMode $handle $config) -ne $expected.mode) { throw 'The startup mode changed during verification.' }
          $turnOff = $data.mode -eq 'Manual' -and $config.Start -eq 2
          $restore = $data.mode -in @('Automatic', 'Automatic (Delayed Start)') -and $config.Start -in @(2, 3)
          if (-not ($turnOff -or $restore)) { throw 'Unsupported service startup change.' }
        } catch {
          @{ rejectedBeforeWrite = $_.Exception.Message } | ConvertTo-Json -Compress
          return
        }

        if ($turnOff) {
          [Housekeeper.ServiceConfig]::SetStart($handle, 3)
        } else {
          if ($config.Start -eq 3) { [Housekeeper.ServiceConfig]::SetStart($handle, 2) }
          $delayed = $data.mode -eq 'Automatic (Delayed Start)'
          $config = [Housekeeper.ServiceConfig]::Read($handle)
          Assert-SameConfig $config $expected
          if ($config.Start -ne 2) { throw 'The startup mode changed during restore.' }
          if ([Housekeeper.ServiceConfig]::IsDelayed($handle) -ne $delayed) { [Housekeeper.ServiceConfig]::SetDelayed($handle, $delayed) }
        }

        $result = [Housekeeper.ServiceConfig]::Read($handle)
        Assert-SameConfig $result $expected
        if ((Get-StartupMode $handle $result) -cne $data.mode) { throw 'Could not verify the new service startup mode.' }
        'verified'
      } finally { if ($null -ne $handle) { $handle.Dispose() } }
      return
    }

    $warnings = [Collections.Generic.List[string]]::new()
    $services = @(
      foreach ($identity in $data.identities) {
        $handle = $null
        try {
          $handle = [Housekeeper.ServiceConfig]::Open($identity.name)
          if ($null -ne $handle) { Get-VerifiedService $identity $handle }
        } catch { $warnings.Add("Could not verify $($identity.name) for startup changes. $($_.Exception.Message)") }
        finally { if ($null -ne $handle) { $handle.Dispose() } }
      }
    )
    [pscustomobject]@{ elevated = $true; services = $services; warnings = $warnings } | ConvertTo-Json -Depth 4 -Compress
`
