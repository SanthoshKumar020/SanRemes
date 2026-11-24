# SanRemes one-click install (Windows PowerShell).
#
#   irm https://raw.githubusercontent.com/SanthoshKumar020/SanRemes/main/install.ps1 | iex
#
# Checks for Node 24+ and pnpm, clones the repo when run outside a checkout,
# installs dependencies, and starts the desktop app. On first run SanRemes asks
# for a free Groq API key (console.groq.com, free tier, no card) — no Claude,
# Codex or Grok subscription is needed.
$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/SanthoshKumar020/SanRemes"
$DefaultDir = Join-Path $HOME "SanRemes"

function Fail($Message) { Write-Error "install.ps1: $Message"; exit 1 }

# Node 24+ is required (package.json engines).
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js is not installed. Install Node 24 or newer from https://nodejs.org, then run this script again."
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]"))
if ($nodeMajor -lt 24) {
  Fail "Node $nodeMajor found, but SanRemes needs Node 24 or newer. Upgrade Node, then run this script again."
}
Write-Host "Node $(node --version) OK"

# pnpm, via corepack when available, else npm.
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "pnpm not found, installing it..."
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    corepack enable
    corepack prepare pnpm@10.33.0 --activate
  } else {
    npm install -g pnpm@10.33.0
  }
}
Write-Host "pnpm $(pnpm --version) OK"

# Clone when this script runs outside a checkout (the irm | iex path).
$inCheckout = (Test-Path package.json) -and (Select-String -Path package.json -Pattern '"name": "sanremes"' -Quiet)
if ($inCheckout) {
  Write-Host "Already in a SanRemes checkout: $(Get-Location)"
} else {
  $dir = if ($env:SANREMES_DIR) { $env:SANREMES_DIR } else { $DefaultDir }
  if (Test-Path (Join-Path $dir ".git")) {
    Write-Host "Updating existing checkout at $dir"
    Set-Location $dir
    git pull --ff-only
  } elseif (Test-Path $dir) {
    Fail "$dir exists but is not a SanRemes checkout. Move it aside or set SANREMES_DIR to another folder."
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      Fail "git is not installed. Install git, then run this script again."
    }
    Write-Host "Cloning SanRemes to $dir"
    git clone $RepoUrl $dir
    Set-Location $dir
  }
}

Write-Host "Installing dependencies (this takes a few minutes the first time)..."
pnpm install

Write-Host ""
Write-Host "Starting SanRemes..."
Write-Host "First run: paste a free Groq API key when asked — get one at https://console.groq.com (free tier, no card)."
Write-Host "To start it again later: cd $(Get-Location); pnpm dev:desktop"
pnpm dev:desktop
