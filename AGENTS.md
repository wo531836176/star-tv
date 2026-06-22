# StarTV 项目约束

## 1. 计划模式
- 在 plan 模式下，做好的计划直接输出给用户查看，不要只写文件

## 2. 不确定的事情
- 有任何不确定的地方，必须询问用户，不要自行决定

## 3. 服务重启
- 每次改动代码后，如果需要重启服务才能生效，请直接重启，不要等用户提醒
- 重启命令：先 `netstat -ano | findstr ":8888 "` 找到 PID，再 `taskkill /F /PID <pid>`，最后 `Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "E:\tvApp" -WindowStyle Hidden`

## 4.每次重启
- 希望在我的首页logo旁边加上版本号，每次发布累加0.01
- 当前版本：v1.06
- 版本号位置：`index.html` 中 `<div class="logo">` 内的 `<span>` 标签
- **重要：每次调整代码前，先修改版本号+0.01，再开始调整代码，最后重启服务**

## 5. 网络配置
- 公网IP：180.158.30.250（上海电信）
- 路由器地址：192.168.26.254
- 电脑局域网IP：192.168.26.66
- 外网访问：http://180.158.30.250:8888（需配置路由器端口转发）
- Cloudflare Tunnel 地址：https://mild-heath-tournaments-referring.trycloudflare.com（临时地址，重启会变）
- Cloudflare 工具位置：E:\tvApp\lib\cloudflared.exe
- 路由器端口转发：外部8888 → 内部192.168.26.66:8888 TCP

## 6. 开机自启动
- 启动脚本：E:\tvApp\start-server.bat
- 已配置 Windows 启动文件夹，登录后自动运行