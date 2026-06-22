const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');
const crypto = require('crypto');

const PORT = process.env.PORT || 8888;
const ROOT = __dirname;
const downloadProgress = {};
const MAX_CONCURRENT_SEGMENTS = 6;
const MAX_CONCURRENT_DOWNLOADS = 5;
const DL_DIR = path.join(ROOT, 'downloads');
const QUEUE_FILE = path.join(DL_DIR, '_queue.json');
const FFMPEG_PATH = path.join(ROOT, 'lib', 'ffmpeg.exe');

// Netdisk search cache (max 50 entries)
const netdiskCache = new Map();
const MAX_CACHE_ENTRIES = 50;

let downloadQueue = [];
let activeDownloads = {};
let completedItems = {};
try {
    if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });
    console.log('[DL_DIR]', DL_DIR, 'exists:', fs.existsSync(DL_DIR));
} catch(e) {
    console.error('[DL_DIR] create failed:', e.message);
}

function saveToLocal(filename, data) {
    try {
        if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });
        const fp = path.join(DL_DIR, filename);
        fs.writeFileSync(fp, data);
        const st = fs.statSync(fp);
        console.log('[SAVE] OK:', fp, 'size:', st.size);
        return true;
    } catch(e) {
        console.error('[SAVE] FAIL:', e.message);
        return false;
    }
}

process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1006l');
if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    try { execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) {}
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.mp4': 'video/mp4'
};

function markCompleted(dlId, task, prog) {
    completedItems[dlId] = {
        dlId,
        name: task.name,
        videoName: task.videoName,
        epName: task.epName,
        status: prog.status || 'done',
        downloaded: prog.downloaded || 0,
        written: prog.written || 0,
        total: prog.total || 0,
        speed: 0,
        done: true,
        error: prog.error || null,
        localFile: prog.localFile || '',
        completedAt: Date.now()
    };
    saveCompleted();
}

const COMPLETED_FILE = path.join(DL_DIR, '_completed.json');

function saveCompleted() {
    try {
        const data = {};
        for (const [k, v] of Object.entries(completedItems)) {
            data[k] = { ...v };
        }
        fs.writeFileSync(COMPLETED_FILE, JSON.stringify(data, null, 2));
    } catch(e) {
        console.error('[COMPLETED] save failed:', e.message);
    }
}

function loadCompleted() {
    try {
        if (fs.existsSync(COMPLETED_FILE)) {
            const data = JSON.parse(fs.readFileSync(COMPLETED_FILE, 'utf8'));
            for (const [k, v] of Object.entries(data)) {
                completedItems[k] = v;
            }
            console.log('[COMPLETED] restored', Object.keys(data).length, 'completed items');
        }
    } catch(e) {
        console.error('[COMPLETED] load failed:', e.message);
    }
}

function removeCompleted(dlId) {
    delete completedItems[dlId];
    saveCompleted();
}

function saveQueue() {
    try {
        const data = {
            queue: downloadQueue.map(item => ({
                dlId: item.dlId,
                url: item.url,
                name: item.name,
                videoName: item.videoName,
                epName: item.epName,
                addedAt: item.addedAt
            })),
            active: Object.keys(activeDownloads)
        };
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
    } catch(e) {
        console.error('[QUEUE] save failed:', e.message);
    }
}

function loadQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            const data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
            if (data.queue && Array.isArray(data.queue)) {
                downloadQueue = data.queue.map(item => ({
                    ...item,
                    addedAt: item.addedAt || Date.now()
                }));
                console.log('[QUEUE] restored', downloadQueue.length, 'pending items');
            }
            try { fs.unlinkSync(QUEUE_FILE); } catch(_) {}
        }
    } catch(e) {
        console.error('[QUEUE] load failed:', e.message);
    }
    loadCompleted();
}

function proxyRequest(targetUrl, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(targetUrl);
        const client = u.protocol === 'https:' ? https : http;
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Referer': u.origin + '/',
            ...opts.headers
        };
        const timeout = opts.timeout || 10000;
        const method = opts.method || 'GET';
        const req = client.request(targetUrl, { headers, timeout, method }, (res) => {
            resolve(res);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

function proxyFetch(targetUrl, maxRedirects) {
    if (maxRedirects === undefined) maxRedirects = 5;
    return new Promise((resolve, reject) => {
        proxyRequest(targetUrl).then(res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
                res.resume();
                let loc = res.headers.location;
                if (loc.startsWith('/')) loc = new URL(targetUrl).origin + loc;
                proxyFetch(loc, maxRedirects - 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode < 200 || res.statusCode >= 400) {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ' from ' + targetUrl.substring(0, 80))));
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).catch(reject);
    });
}

function proxyFetchBinary(targetUrl) {
    return new Promise((resolve, reject) => {
        proxyRequest(targetUrl).then(res => {
            if (res.statusCode < 200 || res.statusCode >= 400) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).catch(reject);
    });
}

function proxyStream(targetUrl, res) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timeout')), 30000);
        proxyRequest(targetUrl, { timeout: 30000 }).then(upRes => {
            if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
                clearTimeout(timeout);
                let loc = upRes.headers.location;
                if (loc.startsWith('/')) loc = new URL(targetUrl).origin + loc;
                upRes.resume();
                proxyStream(loc, res).then(resolve).catch(reject);
                return;
            }
            if (upRes.statusCode !== 200) {
                clearTimeout(timeout);
                upRes.resume();
                reject(new Error('HTTP ' + upRes.statusCode));
                return;
            }
            upRes.on('data', chunk => res.write(chunk));
            upRes.on('end', () => { clearTimeout(timeout); resolve(); });
            upRes.on('error', (e) => { clearTimeout(timeout); reject(e); });
        }).catch(e => { clearTimeout(timeout); reject(e); });
    });
}

function rewriteM3U8(content, baseUrl) {
    const dir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    const lines = content.split('\n');
    return lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#EXT-X-ENDLIST')) return line;
        if (trimmed.startsWith('#')) {
            return trimmed;
        }
        let absoluteUrl;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            absoluteUrl = trimmed;
        } else {
            absoluteUrl = new URL(trimmed, dir).href;
        }
        return absoluteUrl;
    }).join('\n');
}

function extractVideoUrl(html, shareUrl) {
    let match = html.match(/url:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
    if (!match) match = html.match(/var\s+main\s*=\s*["']([^"']+)["']/);
    if (match) {
        let videoPath = match[1];
        if (videoPath.startsWith('http://') || videoPath.startsWith('https://')) {
            return videoPath;
        }
        const base = new URL(shareUrl);
        return base.origin + videoPath;
    }
    if (shareUrl.includes('gsuus.com/play/') && !shareUrl.endsWith('.m3u8')) {
        return shareUrl.replace(/\/?$/, '/index.m3u8');
    }
    return null;
}

// ---- Netdisk search functions ----

const NETDISK_DOMAINS = [
    'pan.quark.cn',        // 夸克
    'www.alipan.com',       // 阿里
    'pan.baidu.com',        // 百度
    'pan.baidu.com/s/',     // 百度分享链接
    'www.115.com',          // 115
];

const NETDISK_NAMES = {
    'pan.quark.cn': '夸克网盘',
    'www.alipan.com': '阿里云盘',
    'pan.baidu.com': '百度网盘',
    'www.115.com': '115网盘',
};

const NETDISK_COLORS = {
    'pan.quark.cn': '#6c5ce7',
    'www.alipan.com': '#0984e3',
    'pan.baidu.com': '#2ecc71',
    'www.115.com': '#e17055',
};

function netdiskSearch(kw) {
    return new Promise((resolve, reject) => {
        const query = `site:pan.quark.cn OR site:www.alipan.com OR site:pan.baidu.com OR site:www.115.com ${kw}`;
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
        
        proxyRequest(searchUrl, { timeout: 15000 }).then(res => {
            let html = '';
            res.on('data', chunk => html += chunk);
            res.on('end', () => {
                try {
                    const results = parseNetdiskResults(html, kw);
                    resolve(results);
                } catch (e) {
                    reject(e);
                }
            });
        }).catch(err => {
            reject(new Error('Search failed: ' + err.message));
        });
    });
}

function parseNetdiskResults(html, kw) {
    const results = [];
    
    // 提取搜索结果条目
    // Bing 搜索结果通常在 <li class="b_algo">...</li> 中
    const liRegex = /<li\s+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(html)) !== null) {
        const li = liMatch[1];
        
        // 提取链接和标题
        const linkMatch = li.match(/<a\s+href="([^"]+)"[^>]*>/);
        if (!linkMatch) continue;
        
        const href = linkMatch[1];
        // 提取标题（第一个 <a> 之后的文本）
        const titleMatch = li.match(/<h2[^>]*>\s*<a[^>]*>(.*?)<\/a>\s*<\/h2>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        
        // 描述文本
        const descMatch = li.match(/<span[^>]*class="([^.]*pt[^"]*)"[^>]*>([\s\S]*?)<\/span>/);
        const desc = descMatch ? descMatch[2].replace(/<[^>]+>/g, '').trim() : '';
        
        // 提取域名
        let domain = '';
        try {
            domain = new URL(href).hostname;
        } catch (e) {
            continue;
        }
        
        // 只保留网盘相关的结果
        if (!NETDISK_DOMAINS.some(d => domain.includes(d))) continue;
        
        const netdiskName = NETDISK_NAMES[domain] || '未知网盘';
        const color = NETDISK_COLORS[domain] || '#888';
        
        results.push({
            title: title || desc.substring(0, 100),
            url: href,
            netdisk: netdiskName,
            color: color,
            desc: desc || '',
        });
        
        // 最多返回 20 条
        if (results.length >= 20) break;
    }
    
    // 去重（基于 URL）
    const seen = new Set();
    return results.filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
    }).slice(0, 20);
}

function streamProxy(targetUrl, req, res, _depth) {
    if (_depth === undefined) _depth = 0;
    if (_depth > 5) {
        res.writeHead(508, { 'Content-Type': 'text/plain' });
        res.end('Too many redirects');
        return;
    }
    const u = new URL(targetUrl);
    const client = u.protocol === 'https:' ? https : http;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': u.origin + '/'
    };
    if (req.headers.range) headers['Range'] = req.headers.range;
    const proxyReq = client.get(targetUrl, { headers, timeout: 30000 }, (upRes) => {
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
            let loc = upRes.headers.location;
            if (loc.startsWith('/')) loc = u.origin + loc;
            upRes.resume();
            streamProxy(loc, req, res, _depth + 1);
            return;
        }
        const contentType = upRes.headers['content-type'] || 'application/octet-stream';
        const isSharePage = targetUrl.includes('/share/') || (targetUrl.includes('gsuus.com/play/') && !targetUrl.includes('.m3u8'));
        if (contentType.includes('text/html') && isSharePage) {
            let html = '';
            upRes.on('data', chunk => html += chunk);
            upRes.on('end', () => {
                const videoUrl = extractVideoUrl(html, targetUrl);
                if (videoUrl) {
                    console.log('[PROXY] share->video:', videoUrl.substring(0, 120));
                    streamProxy(videoUrl, req, res, _depth + 1);
                } else {
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Cannot extract video URL from share page');
                }
            });
            return;
        }
        const isM3U8 = contentType.includes('mpegurl') || contentType.includes('m3u8') || targetUrl.includes('.m3u8');
        if (isM3U8) {
            let data = '';
            upRes.on('data', chunk => data += chunk);
            upRes.on('end', () => {
                const rewritten = rewriteM3U8(data, targetUrl);
                res.writeHead(upRes.statusCode, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Range',
                    'Cache-Control': 'no-cache'
                });
                res.end(rewritten);
            });
        } else {
            const respHeaders = {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Range',
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache'
            };
            if (upRes.headers['content-length']) respHeaders['Content-Length'] = upRes.headers['content-length'];
            if (upRes.headers['content-range']) respHeaders['Content-Range'] = upRes.headers['content-range'];
            res.writeHead(upRes.statusCode, respHeaders);
            upRes.pipe(res);
        }
    });
    proxyReq.on('error', (e) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        res.end('Proxy error: ' + e.message);
    });
    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'text/plain' });
        }
        res.end('Proxy timeout');
    });
}

async function executeDownload(task) {
    const { dlId, url: rawUrl, name: videoName } = task;
    console.log('[DOWNLOAD] start:', rawUrl.substring(0, 150), 'dlId:', dlId);
    const dlKey = dlId;
    downloadProgress[dlKey] = { downloaded: 0, written: 0, total: 0, done: false, error: null, speed: 0, startTime: Date.now(), localFile: '', status: 'downloading', _cancelled: false };
    let tmpTsPath, localFilePath, localFilename;
    function isCancelled() { return downloadProgress[dlKey] && downloadProgress[dlKey]._cancelled; }
    try {
        let m3u8Url = rawUrl;
        if (!rawUrl.endsWith('.m3u8')) {
            console.log('[DOWNLOAD] fetching page to extract m3u8...');
            const html = await proxyFetch(rawUrl);
            const extracted = extractVideoUrl(html, rawUrl);
            if (!extracted) throw new Error('Cannot extract m3u8 from page');
            m3u8Url = extracted;
            console.log('[DOWNLOAD] extracted m3u8:', m3u8Url.substring(0, 120));
        }

        const keyCache = {};
        let allSegUrls = [];
        let allSegKeys = [];
        let allSegIVs = [];
        let currentUrl = m3u8Url;
        for (let depth = 0; depth < 3; depth++) {
            const m3u8Content = await proxyFetch(currentUrl);
            console.log('[DOWNLOAD] m3u8[' + depth + '] length:', m3u8Content.length);
            if (!m3u8Content || m3u8Content.length < 10) break;
            const dir = currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1);
            const lines = m3u8Content.split('\n').map(l => l.trim());
            const hasTs = lines.some(l => l.endsWith('.ts') || l.endsWith('.ts?') || (!l.startsWith('#') && !l.endsWith('.m3u8') && l.length > 5));
            const m3u8Refs = lines.filter(l => !l.startsWith('#') && l.trim() && (l.endsWith('.m3u8') || (!l.endsWith('.ts') && !hasTs)));
            if (m3u8Refs.length > 0 && !hasTs) {
                let ref = m3u8Refs[0];
                if (!ref.startsWith('http')) ref = new URL(ref, dir).href;
                currentUrl = ref;
                console.log('[DOWNLOAD] master -> sub m3u8:', ref.substring(0, 120));
                continue;
            }

            let currentKeyUri = null;
            let currentKeyData = null;
            let currentIV = null;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.startsWith('#EXT-X-KEY:')) {
                    const attrs = {};
                    const attrStr = line.substring('#EXT-X-KEY:'.length);
                    const attrParts = attrStr.split(',');
                    for (const part of attrParts) {
                        const [k, v] = part.split('=');
                        if (k && v) attrs[k.trim()] = v.trim().replace(/^"|"$/g, '');
                    }
                    if (attrs.METHOD === 'NONE') {
                        currentKeyUri = null;
                        currentKeyData = null;
                        currentIV = null;
                    } else if (attrs.METHOD && attrs.METHOD !== 'NONE') {
                        if (attrs.URI) {
                            let keyUrl = attrs.URI;
                            if (!keyUrl.startsWith('http')) keyUrl = new URL(keyUrl, dir).href;
                            if (!keyCache[keyUrl]) {
                                console.log('[DOWNLOAD] fetching key:', keyUrl.substring(0, 120));
                                keyCache[keyUrl] = await proxyFetchBinary(keyUrl);
                            }
                            currentKeyData = keyCache[keyUrl];
                            currentKeyUri = keyUrl;
                        }
                        if (attrs.IV) {
                            let ivHex = attrs.IV;
                            if (ivHex.startsWith('0x') || ivHex.startsWith('0X')) ivHex = ivHex.substring(2);
                            currentIV = Buffer.from(ivHex, 'hex');
                        } else {
                            currentIV = null;
                        }
                    }
                    continue;
                }
                if (line.startsWith('#') || !line) continue;
                let segUrl = line;
                if (!segUrl.startsWith('http')) segUrl = new URL(segUrl, dir).href;
                allSegUrls.push(segUrl);
                allSegKeys.push(currentKeyData);
                allSegIVs.push(currentIV);
            }
            break;
        }

        console.log('[DOWNLOAD] total segments:', allSegUrls.length, 'encrypted:', allSegKeys.filter(Boolean).length);
        if (allSegUrls.length === 0) {
            downloadProgress[dlKey] = { downloaded: 0, total: 0, done: true, error: 'No segments found', localFile: '', speed: 0, written: 0, status: 'failed' };
            return;
        }
        downloadProgress[dlKey].total = allSegUrls.length;
        const safeName = videoName.replace(/[^\w\-_. ]/g, '_').substring(0, 80);
        localFilename = safeName + '_' + Date.now() + '.mp4';
        localFilePath = path.join(DL_DIR, localFilename);
        tmpTsPath = path.join(DL_DIR, '_tmp_' + dlId + '_' + Date.now() + '.ts');

        function decryptSegment(data, key, iv, segIndex) {
            if (!key || data.length === 0) return data;
            try {
                let segIV = iv;
                if (!segIV) {
                    segIV = Buffer.alloc(16, 0);
                    const idx = segIndex + 1;
                    segIV.writeUInt32BE(idx, 12);
                    segIV.writeUInt32BE(0, 8);
                }
                const decipher = crypto.createDecipheriv('aes-128-cbc', key, segIV);
                decipher.setAutoPadding(false);
                const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
                const padLen = decrypted[decrypted.length - 1];
                if (padLen > 0 && padLen <= 16) {
                    return decrypted.slice(0, decrypted.length - padLen);
                }
                return decrypted;
            } catch (e) {
                console.error('[DOWNLOAD] decrypt error at seg', segIndex, e.message);
                return data;
            }
        }

        function fetchSeg(segUrl, retries) {
            if (retries === undefined) retries = 3;
            if (isCancelled()) return Promise.resolve(null);
            return new Promise((resolve) => {
                const timeout = setTimeout(() => { 
                    console.error('[DOWNLOAD] seg timeout: ' + segUrl.substring(0, 80));
                    resolve(null); 
                }, 30000);
                proxyRequest(segUrl, { timeout: 30000 }).then(upRes => {
                    if (upRes.statusCode < 200 || upRes.statusCode >= 400) {
                        clearTimeout(timeout);
                        if (retries > 0) {
                            setTimeout(() => fetchSeg(segUrl, retries - 1).then(resolve), 2000);
                        } else {
                            console.error('[DOWNLOAD] seg HTTP ' + upRes.statusCode + ': ' + segUrl.substring(0, 80));
                            resolve(null);
                        }
                        upRes.resume();
                        return;
                    }
                    const chunks = [];
                    upRes.on('data', c => chunks.push(c));
                    upRes.on('end', () => {
                        clearTimeout(timeout);
                        const buf = Buffer.concat(chunks);
                        if (buf.length < 100 && retries > 0) {
                            console.error('[DOWNLOAD] seg too small (' + buf.length + ' bytes), retrying: ' + segUrl.substring(0, 80));
                            setTimeout(() => fetchSeg(segUrl, retries - 1).then(resolve), 2000);
                        } else if (buf.length < 100) {
                            console.error('[DOWNLOAD] seg too small (' + buf.length + ' bytes): ' + segUrl.substring(0, 80));
                            resolve(null);
                        } else {
                            resolve(buf);
                        }
                    });
                    upRes.on('error', (e) => {
                        clearTimeout(timeout);
                        console.error('[DOWNLOAD] seg error:', e.message, segUrl.substring(0, 80));
                        if (retries > 0) setTimeout(() => fetchSeg(segUrl, retries - 1).then(resolve), 2000);
                        else resolve(null);
                    });
                }).catch((e) => {
                    console.error('[DOWNLOAD] seg fetch error:', e.message, segUrl.substring(0, 80));
                    if (retries > 0) setTimeout(() => fetchSeg(segUrl, retries - 1).then(resolve), 2000);
                    else resolve(null);
                });
            });
        }

        const buf = new Array(allSegUrls.length).fill(null);
        let dlHead = 0, dlCount = 0, wrHead = 0;
        let failedSegs = 0;
        let badSegs = 0;

        const writeStream = fs.createWriteStream(tmpTsPath);

        await new Promise((resolve, reject) => {
            let resolveOnce = false;
            function doResolve() {
                if (!resolveOnce) { resolveOnce = true; resolve(); }
            }
            function pump() {
                while (dlCount < MAX_CONCURRENT_SEGMENTS && dlHead < allSegUrls.length) {
                    if (isCancelled()) {
                        writeStream.end();
                        doResolve();
                        return;
                    }
                    const i = dlHead++;
                    dlCount++;
                    fetchSeg(allSegUrls[i]).then(data => {
                        if (isCancelled()) {
                            writeStream.end();
                            doResolve();
                            return;
                        }
                        if (data === null) {
                            failedSegs++;
                            buf[i] = Buffer.alloc(0);
                        } else {
                            let seg = decryptSegment(data, allSegKeys[i], allSegIVs[i], i);
                            if (seg.length > 0 && seg[0] !== 0x47) {
                                badSegs++;
                                if (badSegs <= 5) {
                                    console.error('[DOWNLOAD] seg ' + i + ' missing sync byte (0x' + seg[0].toString(16) + '), size=' + seg.length);
                                }
                                if (badSegs === 1) {
                                    console.error('[DOWNLOAD] first 32 bytes:', seg.slice(0, 32).toString('hex'));
                                }
                            }
                            buf[i] = seg;
                        }
                        dlCount--;
                        downloadProgress[dlKey].downloaded++;
                        const el = (Date.now() - downloadProgress[dlKey].startTime) / 1000;
                        if (el > 0) downloadProgress[dlKey].speed = Math.round((downloadProgress[dlKey].downloaded / el) * 10) / 10;
                        pump();
                        flush();
                    });
                }
            }
            function flush() {
                while (wrHead < allSegUrls.length && buf[wrHead] !== null) {
                    const data = buf[wrHead];
                    buf[wrHead] = null;
                    wrHead++;
                    downloadProgress[dlKey].written = wrHead;
                    if (data.length > 0) {
                        writeStream.write(data);
                    }
                }
                if (wrHead >= allSegUrls.length && dlHead >= allSegUrls.length && dlCount === 0) {
                    writeStream.end();
                    doResolve();
                }
            }
            writeStream.on('error', (e) => { reject(e); });
            pump();
            flush();
        });

        if (failedSegs > 0) {
            console.error('[DOWNLOAD] warning: ' + failedSegs + '/' + allSegUrls.length + ' segments failed to download');
        }
        if (badSegs > 0) {
            console.error('[DOWNLOAD] warning: ' + badSegs + '/' + allSegUrls.length + ' segments have invalid TS data');
        }

        const tmpStat = fs.statSync(tmpTsPath);
        console.log('[DOWNLOAD] ts file size:', tmpStat.size);
        if (tmpStat.size < 1000) {
            throw new Error('TS file too small (' + tmpStat.size + ' bytes), likely all segments failed');
        }

        console.log('[DOWNLOAD] segments downloaded, converting to MP4...');
        downloadProgress[dlKey].status = 'converting';

        if (isCancelled()) {
            console.log('[DOWNLOAD] cancelled before ffmpeg, dlId:', dlId);
            try { if (tmpTsPath) fs.unlinkSync(tmpTsPath); } catch(_) {}
            return;
        }

        await new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-i', tmpTsPath,
                '-c', 'copy',
                '-movflags', '+faststart',
                '-y', localFilePath
            ];
            console.log('[DOWNLOAD] ffmpeg:', FFMPEG_PATH, ffmpegArgs.join(' '));
            const proc = execFile(FFMPEG_PATH, ffmpegArgs, { timeout: 300000 }, (err, stdout, stderr) => {
                if (err) {
                    console.error('[DOWNLOAD] ffmpeg error:', err.message);
                    if (stderr) {
                        const lines = stderr.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('Invalid'));
                        console.error('[DOWNLOAD] ffmpeg errors:', lines.join('\n'));
                    }
                    reject(new Error('FFmpeg conversion failed: ' + (stderr ? stderr.substring(stderr.length - 300) : err.message)));
                } else {
                    console.log('[DOWNLOAD] ffmpeg done');
                    resolve();
                }
            });
        });

        try { fs.unlinkSync(tmpTsPath); } catch(_) {}

        if (fs.existsSync(localFilePath)) {
            const st = fs.statSync(localFilePath);
            downloadProgress[dlKey].localFile = localFilename;
            console.log('[DOWNLOAD] MP4 saved:', localFilePath, 'size:', st.size);
        }

        downloadProgress[dlKey].done = true;
        downloadProgress[dlKey].status = 'done';
        markCompleted(dlId, task, downloadProgress[dlKey]);
        console.log('[DOWNLOAD] done:', videoName, 'segments:', downloadProgress[dlKey].downloaded + '/' + allSegUrls.length, 'file:', localFilename);
    } catch (e) {
        console.error('[DOWNLOAD] error:', e.message);
        try { if (tmpTsPath) fs.unlinkSync(tmpTsPath); } catch(_) {}
        try { if (localFilePath && fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath); } catch(_) {}
        if (isCancelled()) {
            console.log('[DOWNLOAD] cancelled, cleaned up temp files, dlId:', dlId);
        } else {
            downloadProgress[dlKey].done = true;
            downloadProgress[dlKey].error = e.message;
            downloadProgress[dlKey].status = 'failed';
            markCompleted(dlId, task, downloadProgress[dlKey]);
        }
    }
    setTimeout(() => { delete downloadProgress[dlKey]; }, 300000);
}

function processDownloadQueue() {
    while (Object.keys(activeDownloads).length < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
        const task = downloadQueue.shift();
        activeDownloads[task.dlId] = task;
        console.log('[QUEUE] starting:', task.name, '| remaining:', downloadQueue.length);
        executeDownload(task).then(() => {
            delete activeDownloads[task.dlId];
            processDownloadQueue();
        }).catch((e) => {
            console.error('[QUEUE] download failed:', task.name, e.message);
            delete activeDownloads[task.dlId];
            downloadProgress[task.dlId] = downloadProgress[task.dlId] || {};
            downloadProgress[task.dlId].done = true;
            downloadProgress[task.dlId].error = e.message;
            downloadProgress[task.dlId].status = 'failed';
            markCompleted(task.dlId, task, downloadProgress[task.dlId]);
            processDownloadQueue();
        });
    }
    saveQueue();
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        });
        res.end();
        return;
    }

    if (url.pathname === '/download-start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                console.log('[DOWNLOAD-START] received body:', body.substring(0, 200));
                const data = JSON.parse(body);
                const { url: dlUrl, name, dlId, videoName, epName } = data;
                if (!dlUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ error: 'Missing url' }));
                    return;
                }
                const existing = downloadQueue.find(t => t.dlId === dlId) || activeDownloads[dlId];
                if (existing) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({ ok: true, dlId, status: 'already_queued' }));
                    return;
                }
                const task = { dlId, url: dlUrl, name, videoName: videoName || name, epName: epName || name, addedAt: Date.now() };
                downloadQueue.push(task);
                console.log('[QUEUE] added:', name, '| queue size:', downloadQueue.length);
                processDownloadQueue();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ ok: true, dlId, status: 'queued', queueSize: downloadQueue.length }));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (url.pathname === '/download-status') {
        const allItems = [];
        for (const [dlId, task] of Object.entries(activeDownloads)) {
            const prog = downloadProgress[dlId] || {};
            allItems.push({
                dlId,
                name: task.name,
                videoName: task.videoName,
                epName: task.epName,
                status: prog.status || 'queued',
                downloaded: prog.downloaded || 0,
                written: prog.written || 0,
                total: prog.total || 0,
                speed: prog.speed || 0,
                done: prog.done || false,
                error: prog.error || null,
                localFile: prog.localFile || ''
            });
        }
        for (const task of downloadQueue) {
            allItems.push({
                dlId: task.dlId,
                name: task.name,
                videoName: task.videoName,
                epName: task.epName,
                status: 'queued',
                downloaded: 0,
                written: 0,
                total: 0,
                speed: 0,
                done: false,
                error: null,
                localFile: ''
            });
        }
        for (const [dlId, item] of Object.entries(completedItems)) {
            if (!allItems.find(i => i.dlId === dlId)) {
                allItems.push(item);
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ items: allItems, queueSize: downloadQueue.length, activeCount: Object.keys(activeDownloads).length }));
        return;
    }

    if (url.pathname === '/download-clear-all' && req.method === 'POST') {
        let deletedCount = 0;
        try {
            const files = fs.readdirSync(DL_DIR);
            files.forEach(f => {
                try {
                    fs.unlinkSync(path.join(DL_DIR, f));
                    deletedCount++;
                    console.log('[CLEAR-ALL] deleted:', f);
                } catch(_) {}
            });
        } catch(e) {
            console.error('[CLEAR-ALL] error:', e.message);
        }
        downloadQueue = [];
        Object.keys(activeDownloads).forEach(dlId => {
            if (downloadProgress[dlId]) downloadProgress[dlId]._cancelled = true;
            delete activeDownloads[dlId];
        });
        Object.keys(downloadProgress).forEach(k => delete downloadProgress[k]);
        Object.keys(completedItems).forEach(k => delete completedItems[k]);
        saveCompleted();
        saveQueue();
        console.log('[CLEAR-ALL] done, deleted', deletedCount, 'files');
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, deleted: deletedCount }));
        return;
    }

    if (url.pathname === '/download-cancel' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { dlId } = JSON.parse(body);
                console.log('[DOWNLOAD-CANCEL] requested for dlId:', dlId);
                downloadQueue = downloadQueue.filter(t => t.dlId !== dlId);
                // Set cancel flag so active download can stop gracefully
                if (downloadProgress[dlId]) {
                    downloadProgress[dlId]._cancelled = true;
                }
                // Clean up temp files only for this specific download (match by dlId in filename)
                try {
                    const tmpFiles = fs.readdirSync(DL_DIR).filter(f => f.startsWith('_tmp_') && f.includes(dlId));
                    tmpFiles.forEach(f => {
                        try { fs.unlinkSync(path.join(DL_DIR, f)); console.log('[DOWNLOAD-CANCEL] deleted temp:', f); } catch(_) {}
                    });
                } catch(_) {}
                // Clean up partial MP4 files that were being written
                if (activeDownloads[dlId]) {
                    const task = activeDownloads[dlId];
                    try {
                        const partialFiles = fs.readdirSync(DL_DIR).filter(f => f.includes(task.name) && f.endsWith('.mp4'));
                        partialFiles.forEach(f => {
                            try { fs.unlinkSync(path.join(DL_DIR, f)); console.log('[DOWNLOAD-CANCEL] deleted partial:', f); } catch(_) {}
                        });
                    } catch(_) {}
                }
                delete activeDownloads[dlId];
                delete downloadProgress[dlId];
                removeCompleted(dlId);
                saveQueue();
                processDownloadQueue();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ ok: true }));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (url.pathname === '/parse-m3u8') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing url param' }));
            return;
        }
        try {
            let m3u8Url = targetUrl;
            if (!targetUrl.endsWith('.m3u8')) {
                const html = await proxyFetch(targetUrl);
                const extracted = extractVideoUrl(html, targetUrl);
                if (!extracted) throw new Error('Cannot extract m3u8');
                m3u8Url = extracted;
            }
            let currentUrl = m3u8Url;
            let segments = [];
            let keyMap = {};
            for (let depth = 0; depth < 3; depth++) {
                const m3u8Content = await proxyFetch(currentUrl);
                if (!m3u8Content || m3u8Content.length < 10) break;
                const dir = currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1);
                const lines = m3u8Content.split('\n').map(l => l.trim());
                const hasTs = lines.some(l => l.endsWith('.ts') || l.endsWith('.ts?') || (!l.startsWith('#') && !l.endsWith('.m3u8') && l.length > 5));
                const m3u8Refs = lines.filter(l => !l.startsWith('#') && l.trim() && (l.endsWith('.m3u8') || (!l.endsWith('.ts') && !hasTs)));
                if (m3u8Refs.length > 0 && !hasTs) {
                    let ref = m3u8Refs[0];
                    if (!ref.startsWith('http')) ref = new URL(ref, dir).href;
                    currentUrl = ref;
                    continue;
                }
                let currentKeyUri = null;
                let currentIV = null;
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXT-X-KEY:')) {
                        const attrs = {};
                        const attrStr = line.substring('#EXT-X-KEY:'.length);
                        attrStr.split(',').forEach(p => {
                            const [k, v] = p.split('=');
                            if (k && v) attrs[k.trim()] = v.trim().replace(/^"|"$/g, '');
                        });
                        if (attrs.METHOD === 'NONE') { currentKeyUri = null; currentIV = null; }
                        else if (attrs.METHOD && attrs.METHOD !== 'NONE') {
                            if (attrs.URI) {
                                let keyUrl = attrs.URI;
                                if (!keyUrl.startsWith('http')) keyUrl = new URL(keyUrl, dir).href;
                                currentKeyUri = keyUrl;
                            }
                            currentIV = attrs.IV || null;
                        }
                        continue;
                    }
                    if (line.startsWith('#') || !line) continue;
                    let segUrl = line;
                    if (!segUrl.startsWith('http')) segUrl = new URL(segUrl, dir).href;
                    segments.push({ url: segUrl, keyUrl: currentKeyUri || null, iv: currentIV || null });
                }
                break;
            }
            segments.forEach(s => {
                if (s.keyUrl && !keyMap[s.keyUrl]) keyMap[s.keyUrl] = null;
            });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify({ segments, keyMap: Object.keys(keyMap), m3u8Url, total: segments.length }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (url.pathname === '/api/netdisk-search') {
        const kw = url.searchParams.get('kw');
        if (!kw) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing kw param' }));
            return;
        }
        // 缓存：同一关键词 5 分钟内不发重复请求
        const cacheKey = 'nd_' + crypto.createHash('md5').update(kw).digest('hex');
        const cached = netdiskCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
            console.log('[NETDISK] cache hit:', kw);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
            res.end(JSON.stringify(cached.data));
            return;
        }
        // 用 panapi.fun 或类似免费 API 做网盘搜索代理
        // 如果没有可用 API，返回各搜索引擎链接供前端 iframe 展示
        const engines = [
            { name: '夸克网盘', color: '#6c5ce7', url: `https://www.pansearch.me/search?keyword=${encodeURIComponent(kw)}&pan=quark` },
            { name: '阿里云盘', color: '#0984e3', url: `https://www.pansearch.me/search?keyword=${kw}&pan=aliyun` },
            { name: '百度网盘', color: '#2ecc71', url: `https://www.pansearch.me/search?keyword=${kw}&pan=baidu` },
            { name: '115网盘', color: '#e17055', url: `https://www.pansearch.me/search?keyword=${kw}&pan=115` },
        ];
        const results = { kw, engines, directLinks: [] };
        netdiskCache.set(cacheKey, { data: results, ts: Date.now() });
        console.log('[NETDISK] search prepared:', kw);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(results));
    }

    if (url.pathname === '/api') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing url param');
            return;
        }
        try {
            const data = await proxyFetch(targetUrl);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            res.end(data);
        } catch (e) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Proxy error: ' + e.message);
        }
        return;
    }

    if (url.pathname === '/proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing url param');
            return;
        }
        console.log('[PROXY]', targetUrl.substring(0, 120));
        streamProxy(targetUrl, req, res);
        return;
    }

    if (url.pathname === '/sp91-proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing url param');
            return;
        }
        console.log('[SP91-PROXY]', targetUrl.substring(0, 120));
        const urlMod = require('url');
        const parsedUrl = new urlMod.URL(targetUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const httpMod = isHttps ? require('https') : require('http');
        
        function fetchPage(urlToFetch, redirectCount) {
            if (redirectCount > 5) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Too many redirects');
                return;
            }
            const parsed = new urlMod.URL(urlToFetch);
            const fetchHttps = parsed.protocol === 'https:';
            const fetchMod = fetchHttps ? require('https') : require('http');
            const reqOpts = {
                hostname: parsed.hostname,
                port: parsed.port || (fetchHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'identity',
                    'Connection': 'keep-alive'
                }
            };
            fetchMod.get(reqOpts, (proxyRes) => {
                if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                    let redirectUrl = proxyRes.headers.location;
                    if (redirectUrl.startsWith('/')) {
                        redirectUrl = parsed.origin + redirectUrl;
                    }
                    console.log('[SP91-REDIRECT]', proxyRes.statusCode, redirectUrl.substring(0, 100));
                    fetchPage(redirectUrl, redirectCount + 1);
                    return;
                }
                const contentType = proxyRes.headers['content-type'] || '';
                if (!contentType.includes('text/html')) {
                    res.writeHead(proxyRes.statusCode, {
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*'
                    });
                    proxyRes.pipe(res);
                    return;
                }
                let body = [];
                proxyRes.on('data', (chunk) => { body.push(chunk); });
                proxyRes.on('end', () => {
                    let html = Buffer.concat(body).toString('utf-8');
                    const adBlockScript = `
                    <script>
                    (function(){
                        // Block popups and ads
                        window.open = function(){ return null; };
                        window.alert = function(){};
                        window.confirm = function(){ return true; };
                        window.prompt = function(){ return ''; };
                        
                        // Remove ad elements on load
                        function removeAds(){
                            var adSelectors = [
                                '[class*="ad"]', '[id*="ad"]', '[class*="popup"]', '[id*="popup"]',
                                '[class*="banner"]', '[id*="banner"]', '[class*="overlay"]', '[id*="overlay"]',
                                '[class*="modal"]', '[id*="modal"]', '[class*="float"]', '[id*="float"]',
                                '[class*="fixed"]', '[style*="position:fixed"]', '[style*="position: fixed"]',
                                'iframe[src*="ad"]', 'iframe[src*="click"]', 'iframe[src*="track"]',
                                '.close-btn', '.close-btn-close', '[onclick*="close"]',
                                '[class*="guanggao"]', '[id*="guanggao"]',
                                '[style*="z-index:9999"]', '[style*="z-index: 9999"]',
                                '[style*="z-index:99999"]', '[style*="z-index: 99999"]'
                            ];
                            adSelectors.forEach(function(sel){
                                try{
                                    document.querySelectorAll(sel).forEach(function(el){
                                        if(el.tagName !== 'HTML' && el.tagName !== 'BODY' && el.tagName !== 'MAIN'){
                                            el.remove();
                                        }
                                    });
                                }catch(e){}
                            });
                            // Remove fixed position elements (likely ads)
                            document.querySelectorAll('*').forEach(function(el){
                                var style = window.getComputedStyle(el);
                                if(style.position === 'fixed' && el.tagName !== 'HTML' && el.tagName !== 'BODY'){
                                    var rect = el.getBoundingClientRect();
                                    if(rect.width > 100 && rect.height > 50){
                                        el.remove();
                                    }
                                }
                            });
                        }
                        
                        // Run ad removal immediately and periodically
                        removeAds();
                        setInterval(removeAds, 2000);
                        
                        // Block event-based popups
                        document.addEventListener('click', function(e){
                            var target = e.target;
                            while(target && target !== document.body){
                                if(target.tagName === 'A' && target.href && (target.href.indexOf('ad') > -1 || target.href.indexOf('click') > -1 || target.href.indexOf('track') > -1)){
                                    e.preventDefault();
                                    e.stopPropagation();
                                    return false;
                                }
                                target = target.parentElement;
                            }
                        }, true);
                    })();
                    </script>`;
                    html = html.replace(/<head([^>]*)>/i, function(match) { return match + adBlockScript; });
                    html = html.replace(/<HEAD([^>]*)>/i, function(match) { return match + adBlockScript; });
                    
                    // Also inject at body end to catch dynamically added ads
                    const bodyEndScript = `
                    <script>
                    (function(){
                        setTimeout(function(){
                            var adSelectors = ['[class*="ad"]', '[id*="ad"]', '[class*="popup"]', '[class*="banner"]', '[class*="overlay"]', '[class*="modal"]', '[class*="float"]', '[style*="position:fixed"]'];
                            adSelectors.forEach(function(sel){
                                try{
                                    document.querySelectorAll(sel).forEach(function(el){
                                        if(el.tagName !== 'HTML' && el.tagName !== 'BODY'){
                                            el.style.display = 'none';
                                        }
                                    });
                                }catch(e){}
                            });
                        }, 1000);
                    })();
                    </script>`;
                    html = html.replace(/<\/body>/i, bodyEndScript + '</body>');
                    
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-cache',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(html);
                });
            }).on('error', (e) => {
                console.error('[SP91-PROXY-ERROR]', e.message);
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Proxy error: ' + e.message);
            });
        }
        fetchPage(targetUrl, 0);
        return;
    }

    if (url.pathname === '/download-progress') {
        const dlId = url.searchParams.get('dlId') || '';
        const name = url.searchParams.get('name') || '';
        const prog = downloadProgress[dlId] || downloadProgress[name];
        if (!prog) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ found: false }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ found: true, downloaded: prog.downloaded, written: prog.written || 0, total: prog.total, done: prog.done, error: prog.error, speed: prog.speed || 0, localFile: prog.localFile || '', status: prog.status || '' }));
        return;
    }

    if (url.pathname === '/local-files') {
        try {
            const files = fs.readdirSync(DL_DIR).filter(f => (f.endsWith('.mp4') || f.endsWith('.ts')) && !f.startsWith('_tmp_'));
            const list = files.map(f => {
                const st = fs.statSync(path.join(DL_DIR, f));
                return { name: f, size: st.size, time: st.mtimeMs };
            }).sort((a, b) => b.time - a.time);
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify(list));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error: ' + e.message);
        }
        return;
    }

    if (url.pathname === '/download-verify' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { dlId, filename } = JSON.parse(body);
                const files = fs.readdirSync(DL_DIR).filter(f => f.endsWith('.mp4') && !f.startsWith('_tmp_'));
                let found = null;
                if (filename) {
                    const searchName = filename.replace(/\.mp4$/, '');
                    found = files.find(f => f.startsWith(searchName) && f.endsWith('.mp4'));
                    if (!found) {
                        const safeSearch = searchName.replace(/[^\w\-_. ]/g, '_').substring(0, 80);
                        found = files.find(f => f.startsWith(safeSearch) && f.endsWith('.mp4'));
                    }
                }
                if (!found && dlId) {
                    const task = Object.values(activeDownloads).find(t => t.dlId === dlId);
                    if (task) {
                        const safeName = task.name.replace(/[^\w\-_. ]/g, '_').substring(0, 80);
                        found = files.find(f => f.startsWith(safeName));
                    }
                }
                if (!found && dlId) {
                    const compItem = completedItems[dlId];
                    if (compItem && compItem.localFile) {
                        const localPath = path.join(DL_DIR, compItem.localFile);
                        if (fs.existsSync(localPath)) {
                            const st = fs.statSync(localPath);
                            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                            res.end(JSON.stringify({ found: true, localFile: compItem.localFile, size: st.size }));
                            return;
                        }
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                if (found) {
                    const st = fs.statSync(path.join(DL_DIR, found));
                    res.end(JSON.stringify({ found: true, localFile: found, size: st.size }));
                } else {
                    res.end(JSON.stringify({ found: false }));
                }
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (url.pathname === '/download-file') {
        const filename = url.searchParams.get('file');
        if (!filename || filename.includes('..') || filename.includes('/')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad filename');
            return;
        }
        const localPath = path.join(DL_DIR, filename);
        fs.stat(localPath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found');
                return;
            }
            const ext = path.extname(filename).toLowerCase();
            const contentType = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
            const fileSize = stat.size;
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;
                const fileStream = fs.createReadStream(localPath, { start, end, highWaterMark: 128 * 1024 });
                res.writeHead(206, {
                    'Content-Type': contentType,
                    'Content-Disposition': 'attachment; filename="' + filename.replace(/[^\w\-\.]/g, '_') + '"',
                    'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': 'bytes',
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
                    'Content-Length': chunkSize,
                    'Cache-Control': 'public, max-age=3600',
                    'Connection': 'keep-alive',
                    'X-Content-Type-Options': 'nosniff'
                });
                fileStream.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Disposition': 'attachment; filename="' + filename.replace(/[^\w\-\.]/g, '_') + '"',
                    'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': 'bytes',
                    'Content-Length': fileSize,
                    'Cache-Control': 'public, max-age=3600',
                    'Connection': 'keep-alive',
                    'X-Content-Type-Options': 'nosniff'
                });
                fs.createReadStream(localPath, { highWaterMark: 128 * 1024 }).pipe(res);
            }
        });
        return;
    }

    if (url.pathname === '/local-video') {
        const filename = url.searchParams.get('file');
        if (!filename || filename.includes('..') || filename.includes('/')) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad filename');
            return;
        }
        const localPath = path.join(DL_DIR, filename);
        fs.stat(localPath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found');
                return;
            }
            const ext = path.extname(filename).toLowerCase();
            const contentType = ext === '.mp4' ? 'video/mp4' : 'video/mp2t';
            const fileSize = stat.size;
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = end - start + 1;
                const fileStream = fs.createReadStream(localPath, { start, end, highWaterMark: 128 * 1024 });
                res.writeHead(206, {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': 'bytes',
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
                    'Content-Length': chunkSize,
                    'Cache-Control': 'public, max-age=3600',
                    'Connection': 'keep-alive',
                    'X-Content-Type-Options': 'nosniff'
                });
                fileStream.pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Access-Control-Allow-Origin': '*',
                    'Accept-Ranges': 'bytes',
                    'Content-Length': fileSize,
                    'Cache-Control': 'public, max-age=3600',
                    'Connection': 'keep-alive',
                    'X-Content-Type-Options': 'nosniff'
                });
                fs.createReadStream(localPath, { highWaterMark: 128 * 1024 }).pipe(res);
            }
        });
        return;
    }

    let filePath = path.join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    const ext = path.extname(filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const cacheCtrl = ext === '.html' ? 'no-store, no-cache, must-revalidate' : 'no-cache';
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': cacheCtrl
        });
        res.end(data);
    });
});

process.on('uncaughtException', (e) => { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', (e) => { console.error('Unhandled:', e); });

process.on('SIGINT', () => { saveQueue(); process.exit(0); });
process.on('SIGTERM', () => { saveQueue(); process.exit(0); });

loadQueue();

server.listen(PORT, '0.0.0.0', () => {
    const addr = `http://localhost:${PORT}`;
    console.log('========================================');
    console.log('  StarTV server running');
    console.log('  ' + addr);
    console.log('========================================');
    console.log('  Listening on 0.0.0.0 (external access enabled)');
    console.log('  Max concurrent downloads:', MAX_CONCURRENT_DOWNLOADS);
    console.log('  Press Ctrl+C to stop');
    processDownloadQueue();
});
