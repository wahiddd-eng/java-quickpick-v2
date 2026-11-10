#!/bin/zsh
# Double-click on macOS: installs dependencies (first run), opens the V2 project in VS Code,
# starts the V2 API + student/vendor/admin apps on their own ports (4100, 5273–5275), and opens them.
# V1 uses different ports, so both can run at the same time.
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 20+ from https://nodejs.org and double-click this file again."
  read -k1; exit 1
fi
echo "Using node $(node -v)"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "Installing dependencies (first run takes a minute)…"
  npm install || { echo "npm install failed"; read -k1; exit 1; }
fi
open -b com.microsoft.VSCode . 2>/dev/null || true
( for i in {1..60}; do curl -s -o /dev/null http://localhost:5273 && break; sleep 1; done
  open "http://localhost:5273/s/demo-jg01-qr7k"; open http://localhost:5274; open http://localhost:5275 ) &
npm run dev
