@echo off
chcp 65001 >nul
title StarTV Server

echo.
echo  ============================================
echo    StarTV v3 - 启动中...
echo  ============================================
echo.

:: 检查Node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [错误] 未找到 Node.js，请先安装 Node.js
    pause
    exit /b 1
)

:: 显示本机IP
echo  本机IP地址:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do (
    set "IP=%%a"
    setlocal enabledelayedexpansion
    set "IP=!IP: =!"
    echo    局域网访问: http://!IP!:8888
    endlocal
)
echo    本机访问:   http://localhost:8888
echo.

:: 检查端口是否被占用
netstat -ano | findstr ":8888 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo  [提示] 端口 8888 已被占用，可能服务已在运行
    echo    直接访问 http://localhost:8888
    echo.
    pause
    exit /b 0
)

echo  正在启动服务...
echo  按 Ctrl+C 停止服务
echo.

node server.js

pause
