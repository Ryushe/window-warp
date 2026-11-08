<#
.SYNOPSIS
Check the Microsoft Store account, package identity, and pending submission.
.DESCRIPTION
Read-only preflight for the Store publishing workflow. Microsoft Store CLI
publish replaces a pending submission, so stop before calling it if one exists.
Use -AllowPending for the manual credential check, which never submits anything.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ProductId,
    [switch]$AllowPending
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$desktop = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = [xml](Get-Content -LiteralPath (Join-Path $desktop 'packaging/msix/AppxManifest.xml') -Raw)

$raw = & msstore apps get $ProductId
if ($LASTEXITCODE -ne 0) {
    throw 'Could not read the Microsoft Store application. Check the credentials and application access.'
}
try {
    $app = ($raw | Out-String) | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'The Microsoft Store CLI returned an unexpected application response.'
}
foreach ($name in @('Id', 'PackageIdentityName', 'PublisherName', 'LastPublishedApplicationSubmission', 'PendingApplicationSubmission')) {
    if ($null -eq $app -or $null -eq $app.PSObject.Properties[$name]) {
        throw "The Microsoft Store application response is missing $name."
    }
}
if ($app.Id -cne $ProductId) { throw 'The Microsoft Store returned a different product ID.' }
if ($app.PackageIdentityName -cne $manifest.Package.Identity.Name -or
    $app.PublisherName -cne $manifest.Package.Identity.Publisher) {
    throw 'The MSIX identity or publisher does not match this Partner Center app.'
}
if ($null -eq $app.LastPublishedApplicationSubmission) {
    throw 'The Store app must already have a published submission before automatic updates can run.'
}
if ($null -ne $app.PendingApplicationSubmission) {
    if (-not $AllowPending) {
        throw 'Partner Center has a pending submission. Resolve it before publishing; the Store CLI would replace it.'
    }
    Write-Warning 'Partner Center has a pending submission. A release will not publish until it is resolved.'
}
Write-Output 'Microsoft Store account and package identity verified.'
