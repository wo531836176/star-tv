@echo off
chcp 65001 >nul
title StarTV - 外网穿透

echo.
echo  ============================================
echo    StarTV v3 - 外网穿透工具
echo  ============================================
echo.

:: 优先使用 cloudflared
if exist "%~dp0lib\cloudflared.exe" (
    echo  [cloudflared] 启动外网穿透中...
    echo  稍等几秒，会显示一个 https://xxx.trycloudflare.com 地址
    echo  那就是你的外网访问地址！
    echo.
    "%~dp0lib\cloudflared.exe" tunnel --url http://localhost:8888
    goto :end
)

:: 其次使用 frpc
if exist "%~dp0lib\frpc.exe" (
    if exist "%~dp0lib\frpc.ini" (
        echo  [frp] 启动外网穿透中...
        "%~dp0lib\frpc.exe" -c "%~dp0lib\frpc.ini"
        goto :end
    )
)

:: 都没有，给出提示
echo  [提示] 未找到穿透工具，请选择一种方式安装：
echo.
echo  方式1 - cloudflared（推荐，免费无需注册）:
echo    下载: https://github.com/cloudflare/cloudflared/releases/latest
echo    文件: cloudflared-windows-amd64.exe
echo    放到: lib\cloudflared.exe
echo    然后重新运行此脚本
echo.
echo  方式2 - cpolar（国内，速度快）:
echo    官网: https://www.cpolar.com/
echo    注册后下载客户端，运行:
echo    cpolar http 8888
echo.
echo  方式3 - ngrok（国际，需梯子）:
echo    官网: https://ngrok.com/
echo    运行: ngrok http 8888
echo.
echo  方式4 - natapp（国内免费）:
echo    官网: https://natapp.cn/
echo    注册后下载客户端配置即可
echo.
pause

:end
