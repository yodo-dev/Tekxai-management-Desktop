#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the TekXAI LLC internal code-signing PUBLIC certificate into the
    LocalMachine\TrustedPublisher store so signed TEKxAI Agent installers are
    trusted on this Windows machine without an "Unknown Publisher" warning.

.DESCRIPTION
    This script only ever touches the PUBLIC certificate (.cer). It never
    contains, requests, or installs the private key/PFX/password. It is safe
    to run multiple times — if the certificate is already installed (matched
    by thumbprint), it reports that and makes no changes.

.PARAMETER CertPath
    Path to the TekXAI public certificate file (.cer). Defaults to
    "tekxai-codesign-public.cer" next to this script — place the certificate
    there when preparing a deployment package, or pass -CertPath explicitly.

.EXAMPLE
    .\install-tekxai-code-signing-cert.ps1
    .\install-tekxai-code-signing-cert.ps1 -CertPath C:\deploy\tekxai-codesign-public.cer
#>

[CmdletBinding()]
param(
    [string]$CertPath = (Join-Path $PSScriptRoot 'tekxai-codesign-public.cer')
)

$ErrorActionPreference = 'Stop'

# Known thumbprint of the current TekXAI LLC internal code-signing certificate.
# Update this if the certificate is ever rotated/reissued.
$ExpectedThumbprint = '4DAD471705AE5659F3E6ACE19F5C1160F35A39AB'
$ExpectedSubject    = 'CN=TekXAI LLC, O=TekXAI LLC, C=US'
$StoreLocation      = 'Cert:\LocalMachine\TrustedPublisher'

function Assert-Administrator {
    $identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host ''
        Write-Host 'ERROR: Administrator privileges are required.' -ForegroundColor Red
        Write-Host 'This script installs a certificate into the LocalMachine store.' -ForegroundColor Red
        Write-Host 'Right-click PowerShell (or your terminal) and choose "Run as Administrator", then re-run this script.' -ForegroundColor Yellow
        Write-Host ''
        exit 1
    }
}

function Get-InstalledTekxaiCert {
    Get-ChildItem -Path $StoreLocation -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $ExpectedThumbprint }
}

Write-Host '=== TekXAI Internal Code-Signing Certificate — Install ===' -ForegroundColor Cyan
Write-Host "Target store : $StoreLocation"
Write-Host "Expected thumbprint : $ExpectedThumbprint"
Write-Host ''

Assert-Administrator

$existing = Get-InstalledTekxaiCert
if ($existing) {
    Write-Host 'RESULT: Certificate is already installed. No changes made.' -ForegroundColor Green
    Write-Host "  Subject    : $($existing.Subject)"
    Write-Host "  Thumbprint : $($existing.Thumbprint)"
    Write-Host "  Expires    : $($existing.NotAfter)"
    exit 0
}

if (-not (Test-Path -Path $CertPath -PathType Leaf)) {
    Write-Host "ERROR: Certificate file not found at: $CertPath" -ForegroundColor Red
    Write-Host 'Obtain the TekXAI public certificate (tekxai-codesign-public.cer) from an approved' -ForegroundColor Yellow
    Write-Host 'internal source and either place it next to this script or pass -CertPath explicitly.' -ForegroundColor Yellow
    exit 1
}

try {
    $certToInstall = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertPath)
} catch {
    Write-Host "ERROR: Failed to read certificate file: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if ($certToInstall.HasPrivateKey) {
    Write-Host 'ERROR: The supplied file appears to contain a private key.' -ForegroundColor Red
    Write-Host 'This script only installs the PUBLIC certificate. Aborting for safety.' -ForegroundColor Red
    exit 1
}

if ($certToInstall.Thumbprint -ne $ExpectedThumbprint) {
    Write-Host 'ERROR: Certificate thumbprint does not match the expected TekXAI certificate.' -ForegroundColor Red
    Write-Host "  Found    : $($certToInstall.Thumbprint)"
    Write-Host "  Expected : $ExpectedThumbprint"
    Write-Host 'Refusing to install an unexpected certificate. Verify you have the correct file.' -ForegroundColor Red
    exit 1
}

Write-Host "Installing certificate (Subject: $($certToInstall.Subject)) into $StoreLocation ..."

try {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
    )
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($certToInstall)
    $store.Close()
} catch {
    Write-Host "ERROR: Failed to install certificate: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$verified = Get-InstalledTekxaiCert
if ($verified) {
    Write-Host ''
    Write-Host 'RESULT: Certificate installed and verified successfully.' -ForegroundColor Green
    Write-Host "  Subject    : $($verified.Subject)"
    Write-Host "  Thumbprint : $($verified.Thumbprint)"
    Write-Host "  Expires    : $($verified.NotAfter)"
    Write-Host ''
    Write-Host 'Note: this establishes Authenticode publisher trust only.' -ForegroundColor Yellow
    Write-Host 'It does not grant Microsoft SmartScreen reputation — see WINDOWS_CODE_SIGNING_DEPLOYMENT.md.' -ForegroundColor Yellow
    exit 0
} else {
    Write-Host 'ERROR: Installation did not verify — certificate not found in store after install.' -ForegroundColor Red
    exit 1
}
