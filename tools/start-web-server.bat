@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

echo Servidor web da demonstração
echo.
echo PC local:
echo   http://localhost:8080
echo.
echo Outro dispositivo:
echo   http://IP_DO_PC:8080
echo.
echo Use ipconfig para descobrir o IPv4 do computador.
echo O Firewall do Windows pode solicitar liberação da porta TCP 8080.
echo Pressione Ctrl+C para encerrar.
echo.

py -3 --version >nul 2>nul
if not errorlevel 1 (
  py -3 -m http.server 8080 --bind 0.0.0.0
  exit /b %ERRORLEVEL%
)

python --version >nul 2>nul
if not errorlevel 1 (
  python -m http.server 8080 --bind 0.0.0.0
  exit /b %ERRORLEVEL%
)

echo [ERRO] Python não foi encontrado.
echo Instale Python 3 em https://www.python.org/downloads/ e tente novamente.
pause
exit /b 1
