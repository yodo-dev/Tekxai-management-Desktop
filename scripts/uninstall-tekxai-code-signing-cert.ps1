#Requires -Version 5.1
<#
.SYNOPSIS
    Removes ONLY the TekXAI LLC internal code-signing PUBLIC certificate
    (matched by its exact thumbprint) from LocalMachine\TrustedPublisher.

.DESCRIPTION
    This script never touches any other certificate in the store. It matches
    strictly by thumbprint, not by subject name, so it cannot accidentally
    remove an unrelated "TekXAI" entry. Safe to run if the certificate is
    already absent — it will simply report that.

.EXAMPLE
    .\uninstall-tekxai-code-signing-cert.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ExpectedThumbprint = '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB'
$StoreLocation      = 'Cert:\LocalMachine\TrustedPublisher'

function Assert-Administrator {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host ''
        Write-Host 'ERROR: Administrator privileges are required.' -ForegroundColor Red
        Write-Host 'This script removes a certificate from the LocalMachine store.' -ForegroundColor Red
        Write-Host 'Right-click PowerShell (or your terminal) and choose "Run as Administrator", then re-run this script.' -ForegroundColor Yellow
        Write-Host ''
        exit 1
    }
}

Write-Host '=== TekXAI Internal Code-Signing Certificate — Uninstall ===' -ForegroundColor Cyan
Write-Host "Target store : $StoreLocation"
Write-Host "Target thumbprint : $ExpectedThumbprint"
Write-Host ''

Assert-Administrator

$existing = Get-ChildItem -Path $StoreLocation -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $ExpectedThumbprint }

if (-not $existing) {
    Write-Host 'RESULT: Certificate is not installed. Nothing to remove.' -ForegroundColor Green
    exit 0
}

Write-Host "Removing certificate (Subject: $($existing.Subject), Thumbprint: $($existing.Thumbprint)) ..."

try {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
    )
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $toRemove = $store.Certificates | Where-Object { $_.Thumbprint -eq $ExpectedThumbprint }
    foreach ($cert in $toRemove) {
        $store.Remove($cert)
    }
    $store.Close()
} catch {
    Write-Host "ERROR: Failed to remove certificate: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$stillPresent = Get-ChildItem -Path $StoreLocation -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $ExpectedThumbprint }

if (-not $stillPresent) {
    Write-Host 'RESULT: Certificate removed and verified absent.' -ForegroundColor Green
    exit 0
} else {
    Write-Host 'ERROR: Certificate still present after removal attempt.' -ForegroundColor Red
    exit 1
}
