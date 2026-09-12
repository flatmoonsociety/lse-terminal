# Build the Windows desktop app end to end on the Windows build machine:
# python venv, frozen PyInstaller sidecar, smoke test, then the NSIS installer.
# Mirrors build-mac.sh. Run from anywhere: paths are script-relative.
#
# Siblings ..\brue and ..\brue-connect are REQUIRED next to this repo (same
# reason as on mac: brue-language is not on PyPI, pip must see it installed).
#
# Signing: desktop/sign-windows.js signs every binary through Azure Artifact
# Signing when %USERPROFILE%\.lse-signing\signing.env exists, else the
# installer ships unsigned (SmartScreen prompt). Nothing to pass here.
#
# Channel: -Channel demo builds LSE DEMO TERMINAL, a separate app (own name,
# app id, install folder, updater cache and config folder) that installs next
# to the public LSE Terminal and updates from the private token-gated shelf's
# demo/ subfolder, configured by %USERPROFILE%\.lse-signing\devfeed.env
# (DEV_FEED_URL, DEV_FEED_TOKEN), never the repo. Changes land in the demo app
# first; the default builds the public app. "dev" is the old name for demo.
param(
  [ValidateSet("public", "dev", "demo")] [string] $Channel = "public",
  [string] $Python = "python"
)
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Desk = Join-Path $Root "desktop"
# A scheduled task starts in System32 and PyInstaller refuses to run from
# there; the build always works from its own folder.
Set-Location $Desk
$Venv = Join-Path $Root ".wvenv"
$Port = if ($env:LSE_SMOKE_PORT) { $env:LSE_SMOKE_PORT } else { "7897" }

foreach ($sib in @("brue", "brue-connect")) {
  if (-not (Test-Path (Join-Path $Root "..\$sib\pyproject.toml"))) { throw "missing sibling clone ..\$sib next to lse-terminal" }
}

Write-Host "== python venv"
if (-not (Test-Path (Join-Path $Venv "Scripts\python.exe"))) { & $Python -m venv $Venv }
$Py = Join-Path $Venv "Scripts\python.exe"
& $Py -m pip install --quiet --upgrade pip
& $Py -m pip install --quiet -e (Join-Path $Root "..\brue") -e (Join-Path $Root "..\brue-connect")
& $Py -m pip install --quiet -e $Root pyinstaller

Write-Host "== frozen sidecar (PyInstaller onedir)"
# --clean AND a deleted workpath: a plain rebuild reuses the cached Analysis
# and can keep a stale PYZ; never trust the cache.
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Desk "pyi-work"), (Join-Path $Desk "pyi-dist"), (Join-Path $Desk "sidecar\lset-server")
& $Py -m PyInstaller --noconfirm --clean --workpath (Join-Path $Desk "pyi-work") --distpath (Join-Path $Desk "pyi-dist") (Join-Path $Desk "pyi-spec\lset-server.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
New-Item -ItemType Directory -Force -Path (Join-Path $Desk "sidecar") | Out-Null
Copy-Item -Recurse (Join-Path $Desk "pyi-dist\lset-server") (Join-Path $Desk "sidecar\lset-server")

Write-Host "== smoke test on :$Port"
$exe = Join-Path $Desk "sidecar\lset-server\lset-server.exe"
$proc = Start-Process -FilePath $exe -ArgumentList @("--no-browser", "--port", $Port) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Desk "pyi-dist\smoke.log") -RedirectStandardError (Join-Path $Desk "pyi-dist\smoke.err")
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 | Out-Null; $ok = $true; break } catch {}
  if ($proc.HasExited) { break }
  Start-Sleep -Seconds 1
}
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
if (-not $ok) { Get-Content (Join-Path $Desk "pyi-dist\smoke.err") -Tail 40; throw "sidecar failed the smoke test" }
Write-Host "smoke OK"

Write-Host "== electron app (nsis)"
Set-Location $Desk
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
$ebArgs = @("--win")
if ($Channel -eq "dev") { $Channel = "demo" }
if ($Channel -eq "demo") {
  $devfeed = Join-Path $env:USERPROFILE ".lse-signing\devfeed.env"
  if (-not (Test-Path $devfeed)) { throw "-Channel demo needs $devfeed" }
  $kv = @{}
  Get-Content $devfeed | ForEach-Object { if ($_ -match "^([^=#]+)=(.*)$") { $kv[$matches[1].Trim()] = $matches[2].Trim() } }
  # A separate app, not a re-skin of the public one: its own product name
  # (Start menu entry, install folder, taskbar), its own app id (own
  # uninstall entry, so it never replaces a public install), its own package
  # name (own updater cache), and a channel marker in package.json that the
  # shell reads to give the engine its own config folder. The feed is the
  # private shelf's demo/ subfolder so a demo build is never offered to a
  # public install or to a machine following the shelf root.
  $feed = $kv['DEV_FEED_URL'].TrimEnd('/') + '/demo/'
  $ebArgs += '-c.productName=LSE Demo Terminal'
  $ebArgs += '-c.appId=com.londonstrategicedge.terminal.demo'
  $ebArgs += '-c.artifactName=LSE Demo Terminal Setup ${version}.${ext}'
  $ebArgs += '-c.extraMetadata.name=lse-demo-terminal-desktop'
  # Electron names its own data folder (and the single-instance lock) after
  # package.json's top-level productName, which -c.productName leaves alone;
  # without this the demo app locks the public app's folder and quits.
  $ebArgs += '-c.extraMetadata.productName=LSE Demo Terminal'
  $ebArgs += '-c.extraMetadata.lseChannel=demo'
  $ebArgs += "-c.publish.url=$feed"
  $ebArgs += "-c.publish.requestHeaders.X-LSE-Feed=$($kv['DEV_FEED_TOKEN'])"
  Write-Host "   channel: demo (LSE Demo Terminal, private shelf demo/)"
} else {
  Write-Host "   channel: public"
}
npx electron-builder @ebArgs --publish never
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
Write-Host "done:"
Get-ChildItem (Join-Path $Desk "dist") -Filter "*.exe" | ForEach-Object { Write-Host "  $($_.Name)  $($_.Length) bytes" }
