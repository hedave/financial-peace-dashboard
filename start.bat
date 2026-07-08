@echo off
echo Starting Financial Peace Dashboard at http://localhost:8080
echo Press Ctrl+C to stop.
cd /d "%~dp0"

REM Try py launcher first (works after standalone Python uninstalls)
py -3 -m http.server 8080 --bind 127.0.0.1 2>nul
if %errorlevel% equ 0 goto :done

REM Fallback: Anaconda Python (if installed)
if exist "%USERPROFILE%\anaconda3\python.exe" (
  "%USERPROFILE%\anaconda3\python.exe" -m http.server 8080 --bind 127.0.0.1
  goto :done
)

echo.
echo ERROR: Python was not found.
echo Your PC cleanup likely removed Python. Install it from https://www.python.org/downloads/
echo or run:  py -3 -m http.server 8080 --bind 127.0.0.1
echo from this folder if you already have Python via Anaconda.
pause

:done