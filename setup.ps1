# Flightpath one-shot setup (run in PowerShell from repo root).
# Requires Node.js with npm on PATH: https://nodejs.org/

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Assert-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "Missing '$name'. Install Node.js LTS and re-open this terminal."
  }
}

Assert-Command node
Assert-Command npm

Write-Host "== Server: npm install + demo trace ==" -ForegroundColor Cyan
Push-Location (Join-Path $root "server")
npm install
npm run seed-demo
Pop-Location

Write-Host "== Mobile: npm install + align Expo deps ==" -ForegroundColor Cyan
Push-Location (Join-Path $root "mobile")
npm install
npx --yes expo install
Pop-Location

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  1. API:  cd server; npm start   (uses Express if installed, else built-in HTTP)" 
Write-Host "  2. App:  cd mobile; npx expo start"
Write-Host "  Phone:   `$env:EXPO_PUBLIC_API_BASE='http://YOUR_PC_IP:8787'; npx expo start"
