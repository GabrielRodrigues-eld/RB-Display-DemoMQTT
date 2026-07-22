@echo off
setlocal
chcp 65001 >nul

rem Ajuste este caminho caso o Mosquitto esteja instalado em outro local.
set "MOSQUITTO_EXE=C:\Program Files\mosquitto\mosquitto.exe"
set "SCRIPT_DIR=%~dp0"

if exist "%MOSQUITTO_EXE%" goto run

for /f "delims=" %%I in ('where mosquitto.exe 2^>nul') do if not defined MOSQUITTO_FOUND set "MOSQUITTO_FOUND=%%I"
if defined MOSQUITTO_FOUND set "MOSQUITTO_EXE=%MOSQUITTO_FOUND%"

if not exist "%MOSQUITTO_EXE%" (
  echo.
  echo [ERRO] Eclipse Mosquitto não foi encontrado.
  echo Instale pelo site https://mosquitto.org/download/ ou ajuste MOSQUITTO_EXE neste arquivo.
  echo.
  pause
  exit /b 1
)

:run
echo Iniciando broker MQTT da demonstração...
echo TCP local: 127.0.0.1:1883
echo Acesso restrito ao notebook; não existe listener WebSocket MQTT.
echo Configuração: %SCRIPT_DIR%mosquitto.conf
echo.
"%MOSQUITTO_EXE%" -c "%SCRIPT_DIR%mosquitto.conf" -v
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo Broker encerrado com código %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
