@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js não foi encontrado. Instale Node.js 18.17 ou superior.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERRO] npm não foi encontrado junto com o Node.js.
  pause
  exit /b 1
)

if not exist "gateway\node_modules\mqtt\package.json" (
  echo Instalando dependências do gateway...
  pushd gateway
  call npm install --cache .npm-cache
  set "INSTALL_EXIT=%ERRORLEVEL%"
  popd
  if not "%INSTALL_EXIT%"=="0" (
    echo [ERRO] Falha ao instalar dependências do gateway.
    pause
    exit /b %INSTALL_EXIT%
  )
)

echo.
echo Gateway Factory 24 V
echo Web App/API: http://localhost:8080
echo Outro dispositivo: http://IP_DO_NOTEBOOK:8080
echo Configuração opcional: gateway\.env
echo Pressione Ctrl+C para encerrar.
echo.
call npm --prefix gateway start
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
