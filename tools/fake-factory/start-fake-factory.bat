@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js não foi encontrado.
  echo Instale uma versão LTS em https://nodejs.org/ e tente novamente.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERRO] npm não foi encontrado junto com o Node.js.
  pause
  exit /b 1
)

if not exist "node_modules\mqtt\package.json" (
  echo Instalando a dependência MQTT da fábrica falsa...
  call npm install
  if errorlevel 1 (
    echo [ERRO] Não foi possível instalar as dependências.
    pause
    exit /b 1
  )
)

echo Iniciando fábrica falsa. Pressione Ctrl+C para encerrar.
call npm start
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
