<#
.SYNOPSIS
Read-only installer preflight, or opt-in install/uninstall acceptance in a fresh directory.
.EXAMPLE
./desktop/tests/windows/installer.ps1 -Execute
#>
[CmdletBinding()]
param(
    [string]$Installer = "$PSScriptRoot/../../src-tauri/target/release/bundle/nsis/Window Warp_0.1.0_x64-setup.exe",
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitProcess) { throw 'Run this fixture in 64-bit PowerShell.' }
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$runKey = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Run'
$uninstallKey = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/Window Warp'
$productKey = 'HKCU:/Software/windowwarp/Window Warp'
$manufacturerKey = 'HKCU:/Software/windowwarp'
$manufacturerExisted = Test-Path -LiteralPath $manufacturerKey
$links = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Window Warp.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Window Warp.lnk')
)
function RunValue([string]$Name = 'WindowWarp') {
    $key = Get-Item -LiteralPath $runKey -ErrorAction SilentlyContinue
    if ($key -and $key.GetValueNames() -contains $Name) { return $key.GetValue($Name) }
    return $null
}
function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function SettingsSnapshot {
    foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
        $directory = Join-Path $base 'com.windowwarp.desktop'
        [ordered]@{ path = $directory; exists = (Test-Path -LiteralPath $directory) }
        foreach ($name in @('settings.json', 'workspaces.json')) {
            $file = Join-Path $directory $name
            [ordered]@{ path = $file; sha256 = $(if (Test-Path -LiteralPath $file) { (Get-FileHash -LiteralPath $file).Hash } else { $null }) }
        }
    }
}
# Refuse collisions rather than backing up and replacing a real installation.
foreach ($key in @($uninstallKey, $productKey,
    'HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall/Window Warp',
    'HKLM:/Software/WOW6432Node/Microsoft/Windows/CurrentVersion/Uninstall/Window Warp',
    'HKCU:/Software/Classes/AppUserModelId/com.windowwarp.desktop')) {
    Require (-not (Test-Path -LiteralPath $key)) "Existing installation metadata: $key"
}
foreach ($link in $links) { Require (-not (Test-Path -LiteralPath $link)) "Existing shortcut: $link" }
foreach ($name in @('WindowWarp', 'Window Warp')) { Require ($null -eq (RunValue $name)) "Existing startup value: $name" }
Require (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Window Warp'))) 'Existing default installation directory.'
Require (@(Get-Process -Name 'window-warp' -ErrorAction SilentlyContinue).Count -eq 0) 'Window Warp is running.'
$webview = @(
    'HKLM:/SOFTWARE/WOW6432Node/Microsoft/EdgeUpdate/Clients/{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:/SOFTWARE/Microsoft/EdgeUpdate/Clients/{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:/SOFTWARE/Microsoft/EdgeUpdate/Clients/{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
) | Where-Object { (Get-ItemProperty -LiteralPath $_ -Name pv -ErrorAction SilentlyContinue) }
Require (@($webview).Count -gt 0) 'WebView2 must already be installed; this fixture must not bootstrap it.'
$baseline = @(SettingsSnapshot) | ConvertTo-Json -Depth 5 -Compress
$report = [ordered]@{ passed = $false; installer = $installerPath; sha256 = (Get-FileHash -LiteralPath $installerPath).Hash; checks = @(); commands = @() }
if (-not $Execute) {
    [ordered]@{ preflight = 'passed'; installer = $installerPath; sha256 = $report.sha256; execute = $false } | ConvertTo-Json
    return
}
$output = Join-Path ([IO.Path]::GetFullPath("$PSScriptRoot/../../src-tauri/target/windows-validation")) ('installer-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $output | Out-Null
$install = Join-Path $output 'installed app'
$binary = Join-Path $install 'window-warp.exe'
$uninstaller = Join-Path $install 'uninstall.exe'
$ownedValue = '"' + $binary + '" --startup'
$foreignValue = '"' + (Join-Path $output 'other install/window-warp.exe') + '" --startup'
$ownedValues = @($ownedValue, $foreignValue)
$sentinels = @()
$shell = New-Object -ComObject WScript.Shell
function RunInstaller([string]$Program, [string]$Arguments) {
    $report.commands += [ordered]@{ program = $Program; arguments = $Arguments }
    $process = Start-Process -FilePath $Program -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        if (-not $process.WaitForExit(120000)) { $process.Kill(); throw "Installer timed out: $Program" }
        $process.Refresh()
        Require ($process.ExitCode -eq 0) "Installer exit code $($process.ExitCode): $Program"
    } finally { $process.Dispose() }
}
function VerifyLinks {
    foreach ($link in $links) {
        Require (Test-Path -LiteralPath $link) "Missing installed shortcut: $link"
        Require ($shell.CreateShortcut($link).TargetPath -eq $binary) "Shortcut has unexpected target: $link"
    }
}
function Install([bool]$Update = $false) {
    $arguments = '/S ' + $(if ($Update) { '/UPDATE ' } else { '' }) + '/D=' + $install
    RunInstaller $installerPath $arguments
    Require (Test-Path -LiteralPath $binary) 'Installed binary is missing.'
    Require (Test-Path -LiteralPath $uninstaller) 'Installed uninstaller is missing.'
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    Require ($registration.InstallLocation -eq ('"' + $install + '"')) 'Wrong registered installation directory.'
    Require ($registration.UninstallString -eq ('"' + $uninstaller + '"')) 'Wrong registered uninstaller.'
    VerifyLinks
    $report.checks += 'Current-user installation creates its binary, uninstaller, Start Menu and desktop shortcuts, and uninstall registration.'
}
function Uninstall([bool]$Update = $false) {
    Require ([IO.Path]::GetFullPath($install).StartsWith($output + [IO.Path]::DirectorySeparatorChar)) 'Install directory escaped its fixture root.'
    $registered = Get-ItemProperty -LiteralPath $uninstallKey
    Require ($registered.InstallLocation -eq ('"' + $install + '"')) 'Refusing to uninstall another installation.'
    RunInstaller $uninstaller ('/S ' + $(if ($Update) { '/UPDATE ' } else { '' }) + '_?=' + $install)
    Require (-not (Test-Path -LiteralPath $binary)) 'Uninstall left the app binary.'
    Require (-not (Test-Path -LiteralPath $uninstallKey)) 'Uninstall left its registration.'
    foreach ($sentinel in $sentinels) {
        Require ((Test-Path -LiteralPath $sentinel.file) -and [IO.File]::ReadAllText($sentinel.file) -ceq $sentinel.content) 'Uninstall removed or changed app-data sentinel.'
    }
    if (-not $Update) {
        foreach ($link in $links) { Require (-not (Test-Path -LiteralPath $link)) "Uninstall left shortcut: $link" }
    }
    # _?= waits for the actual uninstaller rather than its temporary launcher.
    # Its running executable can remain; remove just that known file afterward.
    if (Test-Path -LiteralPath $uninstaller) { Remove-Item -LiteralPath $uninstaller }
    if (Test-Path -LiteralPath $install) {
        Require (@(Get-ChildItem -LiteralPath $install -Force).Count -eq 0) 'Unexpected files remain in the owned installation directory.'
        Remove-Item -LiteralPath $install
    }
}
try {
    # Exercise preservation even when this account has no previous app settings.
    # Never overwrite settings; use unique owned files in the actual data roots.
    foreach ($base in @($env:APPDATA, $env:LOCALAPPDATA)) {
        $directory = Join-Path $base 'com.windowwarp.desktop'
        $sentinel = @{ directory = $directory; created = -not (Test-Path -LiteralPath $directory); file = (Join-Path $directory ('installer-fixture-' + [guid]::NewGuid() + '.txt')); content = [guid]::NewGuid().ToString() }
        $sentinels += $sentinel
        if ($sentinel.created) { New-Item -ItemType Directory -Path $directory | Out-Null }
        [IO.File]::WriteAllText($sentinel.file, $sentinel.content)
    }
    Install
    New-ItemProperty -LiteralPath $runKey -Name WindowWarp -Value $ownedValue -PropertyType String | Out-Null
    Uninstall
    Require ($null -eq (RunValue)) 'Uninstall did not remove its own startup entry.'
    $report.checks += 'Normal uninstall removes the exact owned startup command, shortcuts, binary and uninstall registration.'

    Install
    New-ItemProperty -LiteralPath $runKey -Name WindowWarp -Value $foreignValue -PropertyType String | Out-Null
    Uninstall
    Require ((RunValue) -ceq $foreignValue) 'Uninstall changed another installation startup command.'
    Remove-ItemProperty -LiteralPath $runKey -Name WindowWarp
    $report.checks += 'Uninstall preserves a startup entry pointing to a different installation.'

    Install
    New-ItemProperty -LiteralPath $runKey -Name WindowWarp -Value $ownedValue -PropertyType String | Out-Null
    Uninstall $true
    Require ((RunValue) -ceq $ownedValue) 'Update-mode uninstall removed startup.'
    VerifyLinks
    Install $true
    Require ((RunValue) -ceq $ownedValue) 'Same-path update did not preserve startup.'
    $report.checks += 'Update-mode removal and same-path reinstallation preserve startup and shortcut targets.'
    Uninstall
    Require ($null -eq (RunValue)) 'Final uninstall left startup.'
    $report.passed = $true
} catch {
    $report.error = $_.ToString()
} finally {
    try {
        if (Test-Path -LiteralPath $uninstallKey) { Uninstall }
        $value = RunValue
        if ($null -ne $value) {
            Require ($ownedValues -contains $value) 'Unrecognized startup value appeared; cleanup refused.'
            Remove-ItemProperty -LiteralPath $runKey -Name WindowWarp
        }
        if (Test-Path -LiteralPath $productKey) {
            Require ((Get-Item -LiteralPath $productKey).GetValue('') -eq $install) 'Unrecognized install-location metadata; cleanup refused.'
            Remove-Item -LiteralPath $productKey
        }
        if (-not $manufacturerExisted -and (Test-Path -LiteralPath $manufacturerKey)) {
            $key = Get-Item -LiteralPath $manufacturerKey
            if ($key.SubKeyCount -eq 0 -and $key.ValueCount -eq 0) { Remove-Item -LiteralPath $manufacturerKey }
        }
        foreach ($sentinel in $sentinels) {
            if (Test-Path -LiteralPath $sentinel.file) {
                Require ([IO.File]::ReadAllText($sentinel.file) -ceq $sentinel.content) 'Changed sentinel; cleanup refused.'
                Remove-Item -LiteralPath $sentinel.file
            }
            if ($sentinel.created -and (Test-Path -LiteralPath $sentinel.directory)) {
                Require (@(Get-ChildItem -LiteralPath $sentinel.directory -Force).Count -eq 0) 'Unexpected app data appeared; preserving it.'
                Remove-Item -LiteralPath $sentinel.directory
            }
        }
        Require (((@(SettingsSnapshot) | ConvertTo-Json -Depth 5 -Compress)) -ceq $baseline) 'Existing application settings changed.'
        Require (@(Get-Process -Name 'window-warp' -ErrorAction SilentlyContinue).Count -eq 0) 'The fixture unexpectedly launched Window Warp.'
        $report.checks += 'Both real app-data roots preserve owned sentinel files through uninstall; existing settings remain unchanged, no normal app was launched, and owned metadata and sentinels were cleaned.'
    } catch { $report.passed = $false; $report.cleanupError = $_.ToString() }
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'result.json') -Encoding UTF8
    $report | ConvertTo-Json -Depth 8
    Write-Host "Receipt: $output/result.json"
}
if (-not $report.passed) { throw 'Installer acceptance failed; inspect result.json.' }
