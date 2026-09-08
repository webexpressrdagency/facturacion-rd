#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instálelo gratis desde https://nodejs.org (versión LTS)"
  read -p "Presione Enter para cerrar..."
  exit 1
fi
(sleep 2 && (open http://localhost:3000 2>/dev/null || xdg-open http://localhost:3000 2>/dev/null)) &
node server.js
