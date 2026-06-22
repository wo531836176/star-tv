@echo off
chcp 65001 >nul
echo ========================================
echo   StarTV Cloudflare Tunnel URL
echo ========================================
echo.
if exist "E:\tvApp\tunnel_url.txt" (
    type "E:\tvApp\tunnel_url.txt"
) else (
    echo 暂无Tunnel记录，请等待启动完成
)
echo.
echo ========================================
pause
