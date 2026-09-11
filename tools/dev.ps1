param(
  [int]$Port = 7787,
  [switch]$Desktop
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Config = Join-Path $Root '.dev-data\config'

if (-not (Test-Path $Python)) { py -3 -m venv (Join-Path $Root '.venv') }
& $Python -m pip install --quiet --upgrade pip
& $Python -m pip install --quiet -e (Join-Path $Root '..\brue') -e (Join-Path $Root '..\brue-connect') -e "$Root[dev]"

Push-Location (Join-Path $Root 'frontend')
try {
  if (-not (Test-Path 'node_modules')) { npm ci --no-audit --no-fund }
  npm run build
} finally { Pop-Location }

$env:LSE_TERMINAL_CONFIG_DIR = $Config
if ($Desktop) {
  Push-Location (Join-Path $Root 'desktop')
  try {
    if (-not (Test-Path 'node_modules')) { npm ci --no-audit --no-fund }
    npm start
  } finally { Pop-Location }
} else {
  & $Python -m lse_terminal.cli --no-browser --host 127.0.0.1 --port $Port
}
