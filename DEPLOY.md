# StarTV 部署指南

## 一、本地启动

双击运行 `start.bat`，服务会在端口 **8888** 启动。

- 本机访问：http://localhost:8888
- 局域网访问：http://192.168.26.66:8888（同一WiFi下的手机/电脑均可访问）

> 如果端口被占用，修改 `server.js` 第一行的 `PORT = 8888` 改成其他端口即可。

### 手机端使用提示

1. **搜索**：点击搜索框，输入关键词后回车搜索，支持搜索历史
2. **分类**：点击顶部导航（电影/电视剧/综艺/动漫）切换分类
3. **无限滚动**：分类页面往下滑动自动加载更多内容
4. **播放**：点击视频卡片进入详情页，选择剧集播放
5. **下载**：详情页点击下载按钮，选择剧集后开始下载
6. **收藏**：详情页点击收藏按钮，可在收藏页查看

---

## 二、外网访问（内网穿透）

选以下任意一种方式，**推荐 cpolar（国内速度快，免费）**：

---

### 方案A：cpolar（推荐，国内）

1. 访问 https://www.cpolar.com/ 注册账号（免费）
2. 下载安装 Windows 客户端
3. 认证：`cpolar authtoken 你的token`
4. 启动穿透：`cpolar http 8888`
5. 终端会显示类似 `https://xxxx.cpolar.top` 的外网地址

**免费版限制**：随机子域名，每次重启地址会变

---

### 方案B：cloudflared（免费，无需注册，但需能访问Cloudflare）

1. 下载：https://github.com/cloudflare/cloudflared/releases/latest
   - 文件：`cloudflared-windows-amd64.exe`
   - 放到：`lib\cloudflared.exe`
2. 双击运行 `tunnel.bat`
3. 等几秒，终端显示 `https://xxx.trycloudflare.com` 即为外网地址

---

### 方案C：natapp（国内，免费隧道）

1. 访问 https://natapp.cn/ 注册账号
2. 创建一个免费隧道，协议选 HTTP，本地端口填 8888
3. 下载客户端，按官方教程配置 `authtoken`
4. 运行后会显示外网访问地址

---

### 方案D：frp（自建服务器方案，最稳定）

适合有云服务器的情况：

1. 在云服务器上运行 `frps`（服务端）
2. 在本地运行 `frpc`（客户端），配置指向云服务器
3. 访问云服务器的公网IP即可

frpc 客户端配置示例（`lib/frpc.ini`）：
```ini
[common]
server_addr = 你的云服务器IP
server_port = 7000

[startv]
type = http
local_port = 8888
custom_domains = tv.yourdomain.com
```

---

## 三、防火墙设置

如果局域网其他设备无法访问，在 Windows 防火墙中放行 8888 端口：

```
控制面板 → Windows Defender 防火墙 → 高级设置
→ 入站规则 → 新建规则 → 端口 → TCP → 8888 → 允许连接
```

---

## 四、开机自启（可选）

如果希望电脑开机后自动启动 StarTV：

1. 按 `Win+R`，输入 `shell:startup` 回车
2. 把 `start.bat` 的快捷方式放进去即可

---

## 五、文件结构

```
tvApp/
├── index.html          # 前端主页面
├── server.js           # 后端服务（Node.js）
├── start.bat           # 一键启动
├── tunnel.bat          # 外网穿透启动
├── css/                # 样式文件
├── js/                 # 前端脚本
├── lib/
│   ├── ffmpeg.exe      # 视频转码
│   ├── ffprobe.exe     # 视频分析
│   └── hls.min.js      # HLS播放器
└── downloads/          # 下载的视频存放目录
```
