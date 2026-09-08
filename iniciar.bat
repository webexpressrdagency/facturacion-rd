@echo off
title Sistema de Facturacion y Recibos
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js. Instalelo gratis desde https://nodejs.org  ^(version LTS^)
  echo.
  pause
  exit /b
)
start "" http://localhost:3000
node server.js
pause
