@echo off
echo Starting FigPig Financial at http://localhost:8080
echo Press Ctrl+C to stop.
cd /d "%~dp0"

REM 1) Node (reliable if Node.js is installed — no Python needed)
where node >nul 2>&1
if %errorlevel% equ 0 (
  node -e "const http=require('http'),fs=require('fs'),path=require('path');const root=path.resolve(process.cwd());const port=8080;const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json','.woff':'font/woff','.woff2':'font/woff2','.map':'application/json'};http.createServer((req,res)=>{try{let p=decodeURIComponent(new URL(req.url||'/', 'http://127.0.0.1').pathname);if(p==='/')p='/index.html';const file=path.normalize(path.join(root,p));if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden');}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}const ext=path.extname(file).toLowerCase();res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':'no-cache'});res.end(data);});}catch(e){res.writeHead(500);res.end(String(e));}}).listen(port,'127.0.0.1',()=>console.log('Serving http://127.0.0.1:'+port));"
  goto :done
)

REM 2) Python launcher
py -3 -m http.server 8080 --bind 127.0.0.1 2>nul
if %errorlevel% equ 0 goto :done

REM 3) Anaconda Python
if exist "%USERPROFILE%\anaconda3\python.exe" (
  "%USERPROFILE%\anaconda3\python.exe" -m http.server 8080 --bind 127.0.0.1
  goto :done
)
if exist "%USERPROFILE%\AppData\Local\anaconda3\python.exe" (
  "%USERPROFILE%\AppData\Local\anaconda3\python.exe" -m http.server 8080 --bind 127.0.0.1
  goto :done
)

echo.
echo ERROR: No local server runtime found.
echo Install Node.js from https://nodejs.org/  OR  Python from https://www.python.org/downloads/
echo Then double-click start.bat again.
pause

:done
