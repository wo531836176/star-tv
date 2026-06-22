@echo off
chcp 65001 >nul
title StarTV Server

:: 检查服务是否已在运行
netstat -ano | findstr ":8888 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    exit /b 0
)

:: 启动 Node.js 服务
cd /d E:\tvApp
start /b node server.js

:: 等待服务启动
timeout /t 2 /nobreak >nul

:: 启动 Cloudflare Tunnel 并保存域名
echo [%date% %time%] Starting Cloudflare Tunnel... > E:\tvApp\tunnel_url.txt
E:\tvApp\lib\cloudflared.exe tunnel --url http://localhost:8888 2>&1 | findstr "trycloudflare.com" >> E:\tvApp\tunnel_url.txt
