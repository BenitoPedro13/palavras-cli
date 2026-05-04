#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3456}"
echo "A servir a pasta web/ em http://127.0.0.1:${PORT}/"
echo "Abre esse URL no browser (file:// não carrega bem o worker do Tesseract)."
echo "Para parar: Ctrl+C"
cd "$ROOT/web"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "${PORT}"
else
  cd "$ROOT"
  echo "python3 não encontrado; a tentar npx serve…"
  exec npx --yes serve@14 web -l "${PORT}"
fi
