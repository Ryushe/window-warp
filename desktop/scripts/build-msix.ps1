<#
.SYNOPSIS
Package an already-built Windows release executable as an unsigned Store MSIX.
.DESCRIPTION
Run the Tauri release build first. The manifest contains the Store identity used
by the earlier package; verify it against Partner Center before submission.
The output is not installed or signed. Existing packages are never overwritten.
.EXAMPLE
./desktop/scripts/build-msix.ps1
.EXAMPLE
./desktop/scripts/build-msix.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Binary = "$PSScriptRoot/../src-tauri/target/release/window-warp.exe",
    [string]$OutputDirectory = "$PSScriptRoot/../src-tauri/target/release/bundle/msix",
    [string]$MakeAppx = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$desktop = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$packageRoot = Join-Path $desktop 'packaging/msix'
$manifestPath = Join-Path $packageRoot 'AppxManifest.xml'
$manifest = [xml](Get-Content -LiteralPath $manifestPath -Raw)
$appVersion = (Get-Content -LiteralPath (Join-Path $desktop 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
$packageVersion = "$appVersion.0"
if ($manifest.Package.Identity.Version -ne $packageVersion) {
    throw "MSIX manifest version must be $packageVersion to match tauri.conf.json."
}
$binaryVersion = (Get-Item -LiteralPath $binaryPath).VersionInfo.ProductVersion
if ($binaryVersion -ne $appVersion) {
    throw "The release executable reports version $binaryVersion, expected $appVersion. Rebuild it first."
}
if (-not $MakeAppx) {
    $sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $MakeAppx = Get-ChildItem -LiteralPath $sdkBin -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64/makeappx.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (-not $MakeAppx -or -not (Test-Path -LiteralPath $MakeAppx -PathType Leaf)) {
    throw 'MakeAppx.exe was not found. Install the Windows SDK or pass -MakeAppx.'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
$package = Join-Path $output "WindowWarp_${packageVersion}_x64.msix"
if (Test-Path -LiteralPath $package) { throw "Package already exists: $package" }
if (-not $PSCmdlet.ShouldProcess($package, 'Create unsigned MSIX')) { return }

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stage = [IO.Path]::GetFullPath((Join-Path $tempRoot ('window-warp-msix-' + [guid]::NewGuid())))
if (-not $stage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The temporary staging path is outside the expected directory.'
}
try {
    New-Item -ItemType Directory -Path $stage, $output -Force | Out-Null
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage 'AppxManifest.xml')
    Copy-Item -LiteralPath (Join-Path $packageRoot 'Assets') -Destination $stage -Recurse
    Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $stage 'window-warp.exe')
    & $MakeAppx pack /d $stage /p $package
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE." }
    Write-Output "Unsigned MSIX: $package"
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        if ($resolvedStage -eq $stage -and $resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        } else {
            Write-Warning "Staging path changed; leaving it for inspection: $stage"
        }
    }
}
