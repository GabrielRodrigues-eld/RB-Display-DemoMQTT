@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo Iniciando ambiente completo de simulação Factory 24 V...
echo.

start "Factory 24 V - Mosquitto" cmd /k call "%~dp0tools\mosquitto\start-broker.bat"
timeout /t 2 /nobreak >nul

start "Factory 24 V - Simulador" cmd /k call "%~dp0start-simulation.bat"
timeout /t 2 /nobreak >nul

echo O gateway será executado nesta janela.
call "%~dp0start-gateway.bat"
exit /b %ERRORLEVEL%
