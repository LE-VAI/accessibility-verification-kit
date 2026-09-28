# One command, one report:
#   .\run-verification.ps1 https://your-entry.example
#   .\run-verification.ps1 .\dist\index.html     (a local build, served on 127.0.0.1)
# Everything after the target is passed through: --out, --browser, --no-contract, --json.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'run-verification: Node.js 22 or newer is required (https://nodejs.org)'
    exit 3
}
& node (Join-Path $PSScriptRoot 'verify.mjs') @args
exit $LASTEXITCODE
