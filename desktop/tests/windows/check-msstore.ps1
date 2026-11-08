<# Exercise the Store preflight with a fake CLI; no account or network is used. #>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$desktop = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$preflight = Join-Path $desktop 'scripts/check-msstore.ps1'
$manifest = [xml](Get-Content -LiteralPath (Join-Path $desktop 'packaging/msix/AppxManifest.xml') -Raw)
$productId = '9NVBS6W8RV54'

function global:msstore {
    param([Parameter(ValueFromRemainingArguments)] [string[]]$Arguments)
    if (($Arguments -join ' ') -ne "apps get $global:WarpStoreTestProduct") {
        throw 'The test must never submit to Microsoft Store.'
    }
    $global:LASTEXITCODE = $global:WarpStoreTestExitCode
    return $global:WarpStoreTestResponse
}

function Test-Preflight {
    [CmdletBinding()]
    param([string]$Name, [string]$ExpectedError = '', [switch]$AllowPending)
    $failure = $null
    try { & $preflight -ProductId $productId -AllowPending:$AllowPending | Out-Null }
    catch { $failure = $_.Exception.Message }
    if ($ExpectedError -and (-not $failure -or -not $failure.Contains($ExpectedError))) {
        throw "$Name did not report the expected failure: $failure"
    }
    if (-not $ExpectedError -and $failure) { throw "$Name failed: $failure" }
    Write-Output "PASS $Name"
}

try {
    $global:WarpStoreTestProduct = $productId
    $global:WarpStoreTestExitCode = 0
    $app = [ordered]@{
        Id = $productId
        PackageIdentityName = $manifest.Package.Identity.Name
        PublisherName = $manifest.Package.Identity.Publisher
        LastPublishedApplicationSubmission = @{ Id = '123' }
        PendingApplicationSubmission = $null
    }
    $global:WarpStoreTestResponse = $app | ConvertTo-Json -Depth 5
    Test-Preflight 'Existing published app'

    $app.PendingApplicationSubmission = @{ Id = '456' }
    $global:WarpStoreTestResponse = $app | ConvertTo-Json -Depth 5
    Test-Preflight 'Pending draft blocks publishing' -ExpectedError 'pending submission'
    Test-Preflight 'Manual check permits pending draft' -AllowPending -WarningAction SilentlyContinue

    $app.PendingApplicationSubmission = $null
    $app.PackageIdentityName = 'Wrong.Application'
    $global:WarpStoreTestResponse = $app | ConvertTo-Json -Depth 5
    Test-Preflight 'Different package identity' -ExpectedError 'identity or publisher'
    $app.PackageIdentityName = $manifest.Package.Identity.Name
    $app.PublisherName = 'CN=Wrong'
    $global:WarpStoreTestResponse = $app | ConvertTo-Json -Depth 5
    Test-Preflight 'Different publisher' -ExpectedError 'identity or publisher'

    $app.PublisherName = $manifest.Package.Identity.Publisher
    $app.LastPublishedApplicationSubmission = $null
    $global:WarpStoreTestResponse = $app | ConvertTo-Json -Depth 5
    Test-Preflight 'First submission' -ExpectedError 'already have a published submission'
    $app.LastPublishedApplicationSubmission = @{ Id = '123' }
    $app.Remove('PendingApplicationSubmission')
    $global:WarpStoreTestResponse = $app | ConvertTo-Json -Depth 5
    Test-Preflight 'Incomplete Store response' -ExpectedError 'missing PendingApplicationSubmission'

    $global:WarpStoreTestExitCode = 1
    Test-Preflight 'CLI failure' -ExpectedError 'Could not read'
    $global:WarpStoreTestExitCode = 0
    $global:WarpStoreTestResponse = 'not json'
    Test-Preflight 'Invalid Store response' -ExpectedError 'unexpected application response'
} finally {
    Remove-Item -LiteralPath Function:\global:msstore -ErrorAction SilentlyContinue
    Remove-Variable -Name WarpStoreTestProduct, WarpStoreTestExitCode, WarpStoreTestResponse -Scope Global -ErrorAction SilentlyContinue
}
