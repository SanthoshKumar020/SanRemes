#!/usr/bin/env bash
# SanRemes one-click install (macOS, Linux, WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/SanthoshKumar020/SanRemes/main/install.sh | bash
#
# Checks for Node 24+ and pnpm, clones the repo when run outside a checkout,
# installs dependencies, and starts the desktop app. On first run SanRemes asks
# for a free Groq API key (console.groq.com, free tier, no card) — no Claude,
# Codex or Grok subscription is needed.
set -euo pipefail

REPO_URL="https://github.com/SanthoshKumar020/SanRemes"
DEFAULT_DIR="$HOME/SanRemes"

fail() { echo "install.sh: $*" >&2; exit 1; }

# Node 24+ is required (package.json engines).
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install Node 24 or newer from https://nodejs.org (or with nvm/brew), then run this script again."
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 24 ]; then
  fail "Node $NODE_MAJOR found, but SanRemes needs Node 24 or newer. Upgrade Node, then run this script again."
fi
echo "Node $(node --version) OK"

# pnpm, via corepack when available, else npm.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found, installing it..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable && corepack prepare pnpm@10.33.0 --activate
  else
    npm install -g pnpm@10.33.0
  fi
fi
echo "pnpm $(pnpm --version) OK"

# Clone when this script runs outside a checkout (the curl | bash path).
if [ -f package.json ] && grep -q '"name": "sanremes"' package.json 2>/dev/null; then
  echo "Already in a SanRemes checkout: $(pwd)"
else
  DIR="${SANREMES_DIR:-$DEFAULT_DIR}"
  if [ -d "$DIR/.git" ]; then
    echo "Updating existing checkout at $DIR"
    cd "$DIR" && git pull --ff-only
  elif [ -d "$DIR" ]; then
    fail "$DIR exists but is not a SanRemes checkout. Move it aside or set SANREMES_DIR to another folder."
  else
    command -v git >/dev/null 2>&1 || fail "git is not installed. Install git, then run this script again."
    echo "Cloning SanRemes to $DIR"
    git clone "$REPO_URL" "$DIR"
    cd "$DIR"
  fi
fi

echo "Installing dependencies (this takes a few minutes the first time)..."
pnpm install

echo
echo "Starting SanRemes..."
echo "First run: paste a free Groq API key when asked — get one at https://console.groq.com (free tier, no card)."
echo "To start it again later: cd $(pwd) && pnpm dev:desktop"
pnpm dev:desktop
