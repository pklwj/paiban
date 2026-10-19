@echo off
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if %errorlevel%==0 (
  node tests\run.js
  goto done
)
if exist "C:\Users\kk\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" (
  "C:\Users\kk\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" tests\run.js
  goto done
)
echo 没找到 node，请先安装 Node.js，或把 node.exe 路径写进 tests\run.cmd
:done
echo.
pause
