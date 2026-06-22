# StarTV - 版本变更日志

> 记录项目所有功能迭代与问题修复，作为版本档案留存。

---

## v0.8 — 手机端全面优化 & 功能增强（2026-06-15）

### 手机端UI优化
- **搜索栏重构**：
  - 手机端搜索栏改为全宽大框（44px高度），占满整行，更易点击
  - 新增清空按钮（X），输入内容后显示，点击清空输入框并保留空白
  - 输入框获得焦点时自动显示搜索历史面板
- **搜索历史功能**：
  - 最近10条搜索记录保存在localStorage中
  - 点击搜索框时显示搜索历史，方便快捷点击
  - 支持一键清空所有搜索历史
  - 点击历史记录直接搜索
- **视频封面优化**：
  - 手机端网格改为3列布局，一屏可看到更多内容
  - 封面比例从1:1调整为1.2:1（更扁平）
  - 字体进一步缩小（标题9px，副标题8px），更紧凑
- **头部布局优化**：
  - 手机端头部改为两行布局：第一行logo+导航，第二行下载/收藏+搜索栏
  - 下载/收藏按钮增加点击区域（min-height:36px）
  - 导航标签增加点击区域（padding:6px 10px）

### 分类页面优化
- **过滤逻辑修复**：
  - 电影：过滤type_name包含"电影"的内容
  - 电视剧：过滤type_name包含"剧"的内容（包括国产剧、韩剧、美剧、泰剧等）
  - 综艺：过滤type_name包含"综艺"的内容
  - 动漫：过滤type_name包含"动漫"的内容
- **无限滚动加载**：
  - 分类页面支持无限滚动，往下滑动自动加载下一页
  - 每次加载20条数据，从多个资源站聚合
- **数据去重**：
  - 跨资源站按视频ID和名称去重，避免重复显示
  - curCatAllData在渲染时同步更新，确保点击索引正确
- **滚动位置重置**：切换分类时自动回到顶部

### Loading动画
- **可爱脉冲动画**：替换原来的旋转动画，改为弹性脉冲效果
  - 圆圈放大缩小+颜色渐变+阴影扩散
  - 动画时长1.2秒，循环播放

### 资源站更新
- **移除失效资源站**：淘片资源、无尽资源、暴风资源（返回502错误）
- **新增资源站**：天空资源
- **精简资源站列表**：保留6个可靠资源站，避免重复
- **资源站优先级**：光速资源 > 闪电资源 > 非凡资源 > 量子资源 > 红牛资源 > 天空资源

### parseList增强
- 新增`cls`字段：包含`vod_class`信息，为将来过滤扩展做准备
- 保留所有原始字段：id, name, pic, year, area, type, cls, remarks, score, desc, playFrom, playUrl

### 文件变更
- `index.html`：
  - 搜索栏HTML结构重构：新增sbox-wrap、清空按钮、搜索历史面板
  - CSS样式：手机端搜索栏全宽、搜索历史面板、头部布局优化、网格样式调整
  - JavaScript：新增搜索历史相关函数（getSearchHistory, addSearchHistory, clearSearchHistory, renderSearchHistory等）
  - parseList函数：新增cls字段
  - goCat函数：修复过滤逻辑、添加去重、无限滚动
  - renderCatGrid函数：添加名称去重
  - loadHome函数：修复过滤逻辑

### 已知问题
- 部分资源站API偶尔返回502错误（Bad Gateway），但服务器代理会自动重试
- 图片CDN（img.lzipic.com）偶尔连接重置（ERR_CONNECTION_RESET），显示占位图

---

## v0.7 — HLS 解密 & MP4 转码（2026-06-14）

### 功能
- **HLS AES-128 解密**：下载时自动解析 M3U8 中的 `#EXT-X-KEY` 指令，获取加密密钥并解密分片
  - 支持 `METHOD=AES-128` 的 HLS 加密流
  - 密钥缓存机制，避免重复下载同一密钥
  - 自动处理 `#EXT-X-KEY` 的 `IV` 属性，未指定时按 HLS 规范生成默认 IV
  - 无加密（`METHOD=NONE`）的流正常下载不处理
- **ffmpeg TS→MP4 转码**：下载完成后自动调用 ffmpeg 将解密后的 TS 转为 MP4
  - 使用 `-c copy` 无损封装，不重新编码
  - 使用 `-movflags +faststart` 优化 MP4 播放体验
  - ffmpeg 二进制文件放置于 `lib/ffmpeg.exe`
- **MP4 本地播放**：前端下载记录统一使用 `.mp4` 扩展名
  - `/local-video` 端点自动识别 `.mp4` 扩展名，设置正确的 `Content-Type: video/mp4`
  - 浏览器原生支持 MP4 播放，无需 HLS.js
- **下载状态增强**：新增「转换中...」状态（紫色标记），下载完成后自动转 MP4

### 修复
- **下载视频无法播放**：原下载逻辑直接拼接加密的 TS 分片，导致文件头损坏（首字节非 `0x47`），播放器无法识别
- **TS 格式兼容性差**：TS 格式多数播放器不支持，统一转为 MP4 后可用任意播放器播放

### 文件变更
- `server.js`：新增 `crypto`、`child_process.execFile` 导入；新增 `FFMPEG_PATH` 常量；重写 `/download` 处理器支持解密+转码；更新 `/local-video` 支持 MP4 Content-Type；MIME 表新增 `.mp4`
- `index.html`：下载记录文件名从 `.ts` 改为 `.mp4`；下载渲染新增「转换中」状态；`playDownload()` 新增下载中提示
- `lib/ffmpeg.exe`：新增 ffmpeg 二进制文件（约 120MB）

---

## v0.6 — 本地视频播放（2026-06-14）

### 功能
- **服务端文件保存**：下载时用 `fs.writeFileSync` 将所有分片 buffer 拼接后一次性写入 `downloads/` 目录，确保文件落盘（`server.js`）
- **本地文件路由**：新增 `/local-video?file=xxx` 端点，支持 Range 请求、直接播放（`server.js`）
- **下载记录关联**：`X-Local-File` 响应头返回文件名，前端存入 `localFile` 字段
- **播放器"本地视频"角标**：播放本地文件时，播放器左上角显示绿色「本地视频」标签
- **智能播放切换**：
  - 已下载完成 + 有本地文件 → HEAD 请求验证文件存在 → 直接加载本地文件，无需联网
  - 文件已丢失 → 提示「本地文件已丢失，请重新下载」并清除 localFile
  - 旧版本下载（无 localFile）→ 提示「该下载录制于旧版本，无本地文件，请重新下载」
  - 未下载 → 点击播放走代理远程播放
  - `startPlay()` 自动识别 `/local-video` URL，跳过 HLS.js 和代理
- **下载列表状态标记**：已完成的下载显示「本地」绿色标签或「无文件」红色标签

---

## v0.5 — 下载系统修复 & 收藏页完善（2026-06-14）

### 收藏页修复
- **修复封面图缺失**：`renderFavorites()` 添加 SVG 占位图 fallback，当 `pic` 为空或图片加载失败时显示「暂无海报」
- **修复点击播放无反应**：`openFavItem()` 重写为直接初始化播放器模式（设置 `curVid` → `loadPlay()` → 显示详情页 → `setTimeout(playEp, 100)`），不再通过 `openDet()` 间接调用
- **老收藏兼容**：缺少 `playUrl`/`playFrom` 的旧收藏显示提示「该收藏缺少播放源，请重新搜索后收藏」

### 下载系统修复
- **修复下载卡在 0%**：服务端 `/download` 处理器完全重写，用 `pump()`+`flush()` 模式替换有死锁风险的 `segWriteReady` promise-lock 机制
- **修复下载列表为空**：新增 `_syncDlUrls()` 函数，页面加载时从 `localStorage('sv_downloads')` 重建 `_dlUrlSet`，确保去重集合与实际下载记录同步
- **新增版本变更日志**：`CHANGELOG.md` 记录项目所有改动历史

---

## v0.4 — 下载系统（2026-06-14 早些时候）

### 功能
- **服务端并行分片下载**：`server.js` `/download` 端点支持 m3u8 → ts 分片合并下载
  - `MAX_CONCURRENT_SEGMENTS=6` 并行下载分片到内存 buffer
  - 按顺序写入 response，保证文件完整性
  - 进度追踪：`downloaded`（并行完成数，用于速度计算）+ `written`（顺序写入数，用于进度条）
- **前端下载队列**：最多 3 个下载任务同时进行（`_maxConcurrent=3`）
- **下载去重**：`_dlUrlSet` Set + localStorage `sv_dl_urls` 持久化，防止重复下载
- **下载进度轮询**：每 1.5s 查询 `/download-progress` 端点，实时更新进度条和速度
- **下载面板**：底部悬浮面板显示当前下载状态（队列数/活跃数/速度）

### 问题修复
- **进度条跳动**：从 `Math.max(downloaded, idx+1)` 改为独立 `written` 计数器，按顺序递增
- **去重失效**：`_dlUrlSet` 从内存 Set 改为 localStorage 持久化

---

## v0.3 — 收藏、搜索、短剧过滤（2026-06-14）

### 功能
- **收藏系统**：`togFav()` 保存完整视频数据（`id, name, pic, year, area, type, remarks, playUrl, playFrom, desc`）到 `localStorage('sv_f')`
- **收藏页**：独立页面展示收藏列表，支持点击播放、清空收藏
- **全源搜索**：搜索结果聚合所有 8 个资源源，去重后展示
- **短剧过滤**：`SHORT_DRAMA` 正则过滤首页短剧内容（`/短剧|微剧|竖屏|霸总|甜宠|穿越|重生|逆袭|总裁|豪门|战神|赘婿|神医|龙王|至尊|乞丐|透视|鉴宝/i`）
- **下载提示**：顶部居中红色提示条 `showDlHint()`，自动 2.5s 消退

---

## v0.2 — 详情页 & 播放器（2026-06-14 早些时候）

### 功能
- **详情页**：内嵌 16:9 播放器 + 标题/元数据/操作按钮 + 剧集列表 + 简介
- **自定义播放器**：播放/暂停、进度条（可拖拽）、音量、全屏、倍速（0.5x-2x）
- **HLS.js 播放**：支持 m3u8 流媒体，通过服务端代理 `/proxy?url=...` 绕过 CORS
- **自动下一集**：播放结束自动播放下一集
- **快捷键**：空格/K 播放暂停、←→ 快退快进 10s、F 全屏

### 问题修复
- **HLS buffer 调优**：`maxBufferLength:60`, `maxMaxBufferLength:120`, `maxBufferSize:30MB`，平衡启动速度与播放流畅度
- **seek 卡顿**：`_isSeeking` 标记防止 seek 期间触发 stall 恢复逻辑导致跳回
- **HLS ended 事件不触发**：改用 `timeupdate` 比较实现自动下一集

---

## v0.1 — 初始版本（2026-06-13）

### 功能
- **SPA 架构**：纯 HTML/CSS/JS 单页应用，无框架依赖
- **暗色主题**：Netflix 风格深色 UI（`--bg: #0a0a0a`, `--accent: #e50914`）
- **多源聚合**：8 个国内免费视频资源 API（量子、红牛、闪电、光速、非凡、淘片、无尽、暴风）
  - 光速资源优先排序
  - 自动故障转移
- **首页展示**：热门推荐 + 最新更新 + 分类浏览
- **分类筛选**：电影/电视剧/综艺/动漫
- **网盘搜索**：集成 pansearch.me（夸克/阿里/百度/115）
- **服务端代理**：`server.js` 提供 `/api?url=...`（JSON API 代理）和 `/proxy?url=...`（视频流代理，支持 Range 请求）
- **卡片点击**：`onclick="openDet(vidList[N])"` 全局数组方式，避免特殊字符转义问题

### 已知限制
- `img.lzipic.com` CDN 偶尔连接重置（ERR_CONNECTION_RESET），显示灰色占位图
- 量子资源默认列表以短剧为主，需过滤

---

## 技术架构概览

| 模块 | 技术 | 说明 |
|------|------|------|
| 前端 | HTML/CSS/JS | 纯原生，无框架 |
| 播放器 | HLS.js | m3u8 流媒体播放 |
| 服务端 | Node.js server.js | API 代理 + 视频流代理 + HLS解密 + ffmpeg转码 + 本地文件服务 |
| 存储 | localStorage | 收藏(`sv_f`)、下载记录(`sv_downloads`)、下载URL去重(`sv_dl_urls`) |
| 本地文件 | `downloads/` 目录 | 存放下载的 .mp4 文件，通过 `/local-video` 路由播放 |
| 转码工具 | ffmpeg (`lib/ffmpeg.exe`) | TS→MP4 无损转码 |
| 端口 | 8888 | `启动.bat` 启动 |

---

_最后更新：2026-06-14_
