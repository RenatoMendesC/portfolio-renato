@echo off
title Norya Link Engine 1.0
color 0A
setlocal
set "DIR=%LOCALAPPDATA%\NoryaLinkEngine"
if not exist "%DIR%" mkdir "%DIR%"
cd /d "%DIR%"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao encontrado.
  echo Instale o Node.js e execute novamente.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo  NORYA LINK ENGINE 1.0
echo ==========================================
echo Preparando o importador do YouTube...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing 'https://norya-ia.onrender.com/bridge/NoryaLinkEngine.js' -OutFile '%DIR%\NoryaLinkEngine.js'"
if errorlevel 1 (
  echo [ERRO] Nao foi possivel baixar o Link Engine.
  pause
  exit /b 1
)

if not exist "%DIR%\package.json" (
  call npm init -y >nul 2>&1
)
call npm install youtube-dl-exec axios form-data --no-audit --no-fund
if errorlevel 1 (
  echo [ERRO] Falha ao instalar dependencias.
  pause
  exit /b 1
)

cls
echo ==========================================
echo  NORYA LINK ENGINE 1.0
echo ==========================================
echo Deixe esta janela aberta enquanto usar a Norya.
echo.
node "%DIR%\NoryaLinkEngine.js"
echo.
echo O Link Engine foi encerrado.
pause
