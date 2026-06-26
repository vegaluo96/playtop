# 部署（阿里云 ECS · Ubuntu · Nginx）

两个站点共用一台 ECS：

| 站点 | 域名 | 产物 | web root |
|---|---|---|---|
| 用户端 H5 | `zsky.com` | `frontend/dist` | `/var/www/micall` |
| 运营后台 | `admin.zsky.com` | `admin/dist` | `/var/www/micall-admin` |

nginx 模板见 `deploy/nginx/`。两个站点都需 HTTPS 才能用真麦克风/安全 Cookie；大陆 ECS 用域名
访问 80/443 通常需 ICP 备案，未备案可先用 `公网IP:高端口` 临时验证。

---

## 例行更新（每次拉新代码后照这个走）

后端只需拉代码 + 重启（无新依赖、无数据库迁移、nginx 不用动）；两个前端要重新构建部署。

```bash
# 1) 后端：拉代码 + 重启
cd ~/micall.ai && git pull origin main
sudo systemctl restart micall-backend
systemctl status micall-backend            # running 即可

# 2) 用户端 zsky.com
cd ~/micall.ai/frontend && npm ci
# ⚠️ .env.production 必须两行都写：只写 SIGNALING 会抹掉 ICE → RTC 不启用 → 全双工打断失效（落回半双工）。
# VITE_ICE_SERVERS 必须与后端 backend/config/micall.env 的 MICALL_ICE_SERVERS 完全一致（同一 coturn）。
cat > .env.production <<'EOF'
VITE_SIGNALING_URL=wss://zsky.com/realtime/signal
VITE_ICE_SERVERS=[{"urls":"turn:47.82.67.99:3478","username":"micall","credential":"<改成你的TURN密码>"}]
EOF
npm run build && sudo cp -r dist/* /var/www/micall/

# 3) 运营后台 admin.zsky.com
cd ~/micall.ai/admin && npm ci
echo 'VITE_API_BASE=https://admin.zsky.com' > .env.production
npm run build && sudo cp -r dist/* /var/www/micall-admin/
```

> ⚠️ **两个 `.env.production` 都必须非空**。后台留空 → `usingBackend()` 为 false →
> 音色库 / 试听 / 邀请奖励保存等全部退回假数据、不持久化（「邀请奖励改了仍显 60」的常见根因）；
> 用户端留空 → 走内置 mock，不连真实后端。
> 用户端 **`VITE_ICE_SERVERS` 也必须写**（与后端 `MICALL_ICE_SERVERS` 一致）→ 否则 RTC 全双工不启用、
> 通话「打不断」（落回半双工）。`turn:` 地址/密码与 coturn(`deploy` coturn 段) 同步。

**验证**（部署后在服务器上跑）：

```bash
# 邀请奖励：应返回后台设的分钟数（公开接口，不再写死 60）
curl -s https://zsky.com/api/invite-reward

# 用户端音色试听：应是 200 + audio/wav
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" "https://zsky.com/api/voice-preview?c=lin_wan"

# 后台 MiniMax 系统音色库（带 Basic Auth）
curl -s -u admin:<后台密码> https://admin.zsky.com/admin/voices | head -c 200
```

部署后手机务必**硬刷新 / 用无痕窗口**打开，否则继续跑旧 JS（旧的邀请 60、已移除的字体大小入口等）。
音色试听出声需 `backend/config/micall.env` 已配 TTS（线上通话能用即已配）。

新增端点（本次）：`/api/voice-preview`、`/api/invite-reward`（公开）、`/admin/voices`、`/admin/voice-preview`（后台）。

---

## 用户端 zsky.com（更新部署）

```bash
cd ~/micall.ai && git pull origin main
cd frontend && npm ci
echo 'VITE_SIGNALING_URL=' > .env.production    # 暂用 mock；接后端填 wss://zsky.com/realtime/signal
npm run build
sudo mkdir -p /var/www/micall && sudo cp -r dist/* /var/www/micall/

sudo cp ~/micall.ai/deploy/nginx/micall.conf /etc/nginx/sites-available/micall
sudo ln -sf /etc/nginx/sites-available/micall /etc/nginx/sites-enabled/micall
sudo nginx -t && sudo systemctl reload nginx
```

## 运营后台 admin.zsky.com（首次部署）

**1) DNS**：给 `admin.zsky.com` 加一条 A 记录，指向与 `zsky.com` 同一个公网 IP
（或加 `*.zsky.com` 泛解析）。

**2) 构建产物**
```bash
cd ~/micall.ai && git pull origin main
cd admin && npm ci
echo 'VITE_API_BASE=' > .env.production    # 暂用内置 mock；接后端填如 https://zsky.com
npm run build
sudo mkdir -p /var/www/micall-admin && sudo cp -r dist/* /var/www/micall-admin/
```

**3) 访问控制（后台无登录，必须做）**
```bash
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.micall_admin_htpasswd admin   # 按提示设密码
# 之后加人：sudo htpasswd /etc/nginx/.micall_admin_htpasswd <用户名>
```

**4) 站点配置 + reload**
```bash
sudo cp ~/micall.ai/deploy/nginx/micall-admin.conf /etc/nginx/sites-available/micall-admin
sudo ln -sf /etc/nginx/sites-available/micall-admin /etc/nginx/sites-enabled/micall-admin
sudo nginx -t && sudo systemctl reload nginx
```

**5) 放行端口 + HTTPS**
- 阿里云安全组放行 80 / 443。
- 证书（把三个域名一起签）：
  ```bash
  sudo apt-get install -y certbot python3-certbot-nginx
  sudo certbot --nginx -d zsky.com -d www.zsky.com -d admin.zsky.com
  ```

打开 `http(s)://admin.zsky.com` → 输 Basic Auth 账号密码 → 进入后台。

### 后台没配上 HTTPS？逐项排查
1. **DNS**：`dig +short admin.zsky.com` 必须返回你的公网 IP（A 记录没加/没生效，certbot 取不到证）。
2. **Basic Auth 挡了校验**：Let's Encrypt 的 HTTP-01 校验要访问
   `/.well-known/acme-challenge/...`，会被后台的 `auth_basic` 挡成 401 → 取证失败。
   `micall-admin.conf` 已加 `location ^~ /.well-known/acme-challenge/ { auth_basic off; }` 放行；
   确认你用的是仓库里这份最新配置后 `sudo nginx -t && sudo systemctl reload nginx`，再单独补签：
   ```bash
   sudo certbot --nginx -d admin.zsky.com
   ```
3. **80 端口**：certbot HTTP 校验走 80，安全组/防火墙要放行；大陆 ECS 用域名还需 ICP 备案。
4. 签好后 certbot 会自动加 443 跳转；`sudo certbot certificates` 可看已签域名。

### 证书签到了、但「Could not install certificate / 找不到 server block」
certbot 已拿到证书（`/etc/letsencrypt/live/admin.zsky.com/`），只是没能装进 nginx，报
`Could not automatically find a matching server block for admin.zsky.com`。99% 是
**admin 配置没启用**（`sites-enabled` 里没软链），nginx 没加载它，certbot 自然找不到：

```bash
# ① 确认是否启用（应看到指向 sites-available/micall-admin 的软链）
ls -l /etc/nginx/sites-enabled/ | grep micall-admin
# ② 没有就建软链并 reload
sudo ln -sf /etc/nginx/sites-available/micall-admin /etc/nginx/sites-enabled/micall-admin
sudo nginx -t && sudo systemctl reload nginx
# ③ 证书已签好，直接安装到现在能找到的 server block
sudo certbot install --cert-name admin.zsky.com
sudo systemctl reload nginx
```

仍不行就**手动加 443**（证书已存在，直接引用即可），把 `micall-admin.conf` 里的
`server{ listen 80; ... }` 换成下面这套 HTTP→HTTPS + 443：

```nginx
server {
    listen 80; listen [::]:80;
    server_name admin.zsky.com;
    location ^~ /.well-known/acme-challenge/ { auth_basic off; allow all; default_type "text/plain"; }
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2; listen [::]:443 ssl http2;
    server_name admin.zsky.com;
    ssl_certificate     /etc/letsencrypt/live/admin.zsky.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.zsky.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /var/www/micall-admin;
    index index.html;
    location ^~ /.well-known/acme-challenge/ { auth_basic off; allow all; default_type "text/plain"; }
    auth_basic "MiCall Admin";
    auth_basic_user_file /etc/nginx/.micall_admin_htpasswd;
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location = /index.html { add_header Cache-Control "no-cache"; }
    location / { try_files $uri $uri/ /index.html; }
}
```
然后 `sudo nginx -t && sudo systemctl reload nginx`。

---

## 在后台网页里配「接口配置」（不用再 SSH 改 micall.env）

后端已带一个本地配置 API（`backend/src/micall/server/adminapi.py`，随信令服务一起起，
监听 `127.0.0.1:8788`）。运营在 `admin.zsky.com →「接口配置」`网页上填 endpoint/key/模型 →
**保存**写到服务端 `config/admin_overrides.json`（gitignored），**测试**按钮真发一次请求验连通
（1004/2049 这类 key 错误会直接显示出来）。下一通电话即生效，**无需重启**。

优先级：**网页配的 > micall.env 环境变量 > default.json**（铁律2，密钥存服务端、读取打码）。

启用三步：
```bash
# 1) 后端拉新代码 + 重启（重启后会多监听一个 127.0.0.1:8788 的配置 API）
cd ~/micall.ai && git pull origin main
sudo systemctl restart micall-backend
journalctl -u micall-backend -n 5    # 应看到「后台配置 API http://127.0.0.1:8788/admin/api-config」

# 2) nginx 放开 /admin/ 反代（cp 会覆盖 certbot 的 443 块 → 必须重跑 certbot 补回 SSL！）
sudo cp ~/micall.ai/deploy/nginx/micall-admin.conf /etc/nginx/sites-available/micall-admin
sudo certbot --nginx -d admin.zsky.com     # 选 1 reinstall：把 443/SSL 装回（cp 把它覆盖了）
sudo nginx -t && sudo systemctl reload nginx

# 3) admin 指向同源 API 并重新构建
cd ~/micall.ai/admin
echo 'VITE_API_BASE=https://admin.zsky.com' > .env.production
npm run build && sudo cp -r dist/* /var/www/micall-admin/
```
### ⚠️ 必做：后台鉴权（线上 fail closed）

后端**已 fail closed**：未安全配置时 `POST /admin/login` 返回 `503`、其余 `/admin/*` 返回 `401`
（即便 nginx 对 `/admin/` `auth_basic off` 也不会裸奔）。**生产必须设这两个环境变量**
（写进 systemd 的 `EnvironmentFile` 或 `micall.env`，随后端进程加载）：

```bash
# 强密码（≥8 位、非弱口令）
MICALL_ADMIN_PASSWORD='换成你的强密码'
# 长随机 token（≥16 位；下面命令生成一个）
MICALL_ADMIN_TOKEN='paste-a-long-random-string'        # 例：openssl rand -hex 24
# 可选：本地联调放行的 CORS 来源（逗号分隔），线上无需设
# MICALL_ADMIN_ALLOWED_ORIGINS='http://localhost:5174'
```

设好后重启后端。打开 `admin.zsky.com` 先过 nginx Basic Auth（保护静态页），再到 admin 登录页：
- **账号** `admin`（可改 `MICALL_ADMIN_USER`）。
- **密码**：必须等于 `MICALL_ADMIN_PASSWORD`。登录成功后前端带 `Authorization: Bearer <MICALL_ADMIN_TOKEN>`
  访问 `/admin/*`，后端校验该 token——这才是真正的应用级门禁。
- **不要**用 `dev`、`admin`、`changeme` 等弱口令做 token/密码（被视为「未配置」→ fail closed）。

进去后到「接口配置」，填好 TTS/LLM/ASR 的 endpoint+key，点**保存**、点**测试**。
（nginx 把整个 `/admin/`（login + api-config + test）反代到后端 8788；后端只听本地，外网只经 nginx。）

> 仍想用命令行也行：`micall.env` 的环境变量依然有效（被网页配置覆盖）。两者择一即可。

---

## 后端实时信令服务（让前端从 Mock 切到真实后端）

后端骨架在 `backend/`（详见 `backend/README.md`）。生产化三步：

**1) 依赖 + systemd 常驻**（别用前台 `run-server`，关终端就停）
```bash
cd ~/micall.ai && git pull origin main
cd backend && pip3 install -r requirements.txt   # 或：sudo apt install -y python3-websockets
sudo cp ~/micall.ai/deploy/micall-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now micall-backend
systemctl status micall-backend        # running 即可（监听 127.0.0.1:8787，仅本地）
journalctl -u micall-backend -f         # 看日志
```

**2) nginx 反代 wss**（前端是 https，浏览器禁止 https 页面连 ws://，必须加密 wss://）
最新 `deploy/nginx/micall.conf` 已含 `location /realtime/signal` → `127.0.0.1:8787`。
把它合并进你服务器上**实际生效的 443 server 块**（certbot 生成的那个），然后：
```bash
sudo nginx -t && sudo systemctl reload nginx
```
> 无需放行 8787：后端只监听本地，外网只经 443 的 wss 反代进来，更安全。

**3) 前端切真实信令**
```bash
cd ~/micall.ai/frontend
echo 'VITE_SIGNALING_URL=wss://zsky.com/realtime/signal' > .env.production
npm run build && sudo cp -r dist/* /var/www/micall/
```
打开 zsky.com 发起通话即走真实后端（当前是 stub 编排，接入密钥后即真实对话）。

**接真实供应商密钥（铁律2）**：在 `backend/config/micall.env` 写各节点 endpoint/key
（不入库、不进命令行、不进截图），`sudo systemctl restart micall-backend`。模板（按已选最快链路）：

```bash
# 快脑 LLM —— DeepSeek 官方直连（实测 TTFT≈709ms，聚合网关都被卡在 ~2.2s）
MICALL_LLM_FAST_ENDPOINT=https://api.deepseek.com/v1/chat/completions
MICALL_LLM_FAST_API_KEY=sk-xxxx

# TTS —— MiniMax 国内域名 api.minimax.chat（实测首块≈550ms，比国际 minimaxi.com 快≈280ms）
# endpoint 把 GroupId 拼在 query 里；国内/国际是不同账号体系，key 不通用。
MICALL_TTS_ENDPOINT=https://api.minimax.chat/v1/t2a_v2?GroupId=你的GroupId
MICALL_TTS_API_KEY=你的MiniMax国内key

# ASR —— 百炼 Qwen3-ASR-Flash。实测香港→北京区整段 3465ms🔴、新加坡区 675ms🟢（≈5x）→ 用新加坡区。
# 国际站独立账号；若给业务空间专属域名，用控制台「OpenAI 兼容地址」末尾补 /chat/completions。
MICALL_ASR_ENDPOINT=https://ws-你的工作空间.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions
MICALL_ASR_API_KEY=你的国际站key
# 无专属域名时用通用国际站端点：https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
```

各链路单独实测（地基生死验证）：

```bash
cd ~/micall.ai/backend && set -a; . config/micall.env; set +a
PYTHONPATH=src python3 -m micall.cli selfcheck                 # 看各节点是否「已配置」
PYTHONPATH=src python3 -m micall.cli spike                     # LLM TTFT
PYTHONPATH=src python3 scripts/tts_once.py "你好，我今天心情还不错。" sample.mp3   # TTS 首块/整句
PYTHONPATH=src python3 scripts/asr_once.py sample.mp3 --label 北京               # ASR 北京区 p50/p95
# 注册国际站(新加坡)账号拿独立 key 后，同一段音频对比：
MICALL_ASR_ENDPOINT=https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions \
MICALL_ASR_API_KEY=<国际站key> PYTHONPATH=src python3 scripts/asr_once.py sample.mp3 --label 新加坡
```

---

## （可选 / 实验）服务端 WebRTC 全双工

默认通话走 WS+PCM 半双工（稳）。装上 aiortc 后，前端用 `?rtc=1` 打开即改走 WebRTC：麦克风/AI 语音
都走 Opus 媒体通道，浏览器进通信模式 → 移动端外放也能开硬件级 AEC、可边说边随时打断（豆包式）。
**这是实验路径，opt-in、不影响默认通话**；务必先在自己手机上用 `?rtc=1` 验证，确认稳了再考虑设默认。

```bash
# 1) 后端装 aiortc（从 wheel 直装，自带原生库，无需 apt 装 ffmpeg/opus/srtp）
cd ~/micall.ai/backend && sudo pip3 install --break-system-packages aiortc
python3 -c "import aiortc, av; print('aiortc', aiortc.__version__, 'av', av.__version__)"   # 验证可用
sudo systemctl restart micall-backend
journalctl -u micall-backend -n 5 --no-pager    # 启动正常即可（未装 aiortc 时该路径自动跳过）

# 2) 放行 WebRTC 媒体的 UDP 端口（关键！否则 ICE 连不通、听不到声）
#    aiortc 用临时高位 UDP 端口收发媒体。阿里云安全组要放行入站 UDP（最简单：UDP 1024-65535，
#    或自建 TURN 后只放 TURN 端口）。仅放行 443/TCP 是不够的——WebRTC 媒体走 UDP。
```

**没配 coturn 时默认走 WS（即时接通）**，WebRTC 仅 `zsky.com/?rtc=1` 显式试。**配了自建 coturn
（前端 `VITE_ICE_SERVERS` 非空、重新 build）后，默认自动切到 WebRTC 全双工**（真打断 + 外放硬件 AEC），
无需改代码；`?rtc=0` 可强制退回 WS，连不通也会在 ~4.5s 内自动回退。原因：WebRTC 开场要建连
(offer/answer/ICE/DTLS)，境内弱网 + 没有自建 STUN/TURN 时会「一上来反应很慢」——所以必须先架 coturn
（公网 STUN 尤其 Google 在境内不可靠）。

**`?rtc=1` 实验前提 / 局限**：
- **UDP 必须放行**（上面第 2 步）。只开 443 不行。
- **服务端不配 STUN**（境内连不通 Google STUN 会让 aiortc 等 ~5s 才发 answer = 慢的元凶，已去掉）。
  服务端用 **host 候选（公网 IP）** 直连：要求 ECS 公网 IP 能被浏览器直达；NAT 后则需配可达的 STUN/TURN。
- **移动对称 NAT / 境内手机够不到公网 STUN** → 连不通的会在 ~4.5s 内自动回退 WS（不死寂，但开场仍有几秒）。
- 前端 RTCPeerConnection + 真机连通性我无法本地验证，请真机实测、把现象反馈给我再迭代。

### 自建 coturn（把全双工做成可靠默认的正解）

公网 STUN 境内不可靠，自己在 ECS（或同区）上跑 coturn 当 STUN+TURN，覆盖率最高。

```bash
# 1) 装
sudo apt-get install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn

# 2) /etc/turnserver.conf（最小可用，<...> 换成你的值）
sudo tee /etc/turnserver.conf >/dev/null <<'CONF'
listening-port=3478
fingerprint
lt-cred-mech
user=micall:<一个强密码>
realm=zsky.com
# 阿里云 EIP 是 NAT 映射：把"公网IP/内网IP"都填上，coturn 才会对外播报公网 IP
external-ip=<公网IP>/<内网IP>
min-port=49152
max-port=65535
no-cli
CONF
sudo systemctl enable --now coturn && sudo systemctl restart coturn

# 3) 安全组放行：3478 TCP+UDP（STUN/TURN 信令）+ 49152-65535 UDP（媒体中继）
```

接进来（两端都填同一套；填好后即对 `?rtc=1` 生效）：
```bash
# 后端（micall.env，随服务重启生效）
MICALL_ICE_SERVERS='[{"urls":"stun:zsky.com:3478"},{"urls":"turn:zsky.com:3478","username":"micall","credential":"<同上密码>"}]'
# 前端（frontend/.env.production，需重新 build）
VITE_ICE_SERVERS=[{"urls":"stun:zsky.com:3478"},{"urls":"turn:zsky.com:3478","username":"micall","credential":"<同上密码>"}]
```
填好 `VITE_ICE_SERVERS` 重新 `npm run build` 后，**默认即自动走 WebRTC 全双工**（`MiCallLogic` 的 `rtcEnabled`
已据此判定，无需手改代码）。真机若某些网络连不上会自动回退 WS；可用 `?rtc=0` 强制走 WS 做对比。
> 注：把长期 TURN 密码放进前端会暴露给客户端。要更安全用 coturn 的 `use-auth-secret` + 后端发临时凭据，
> 那需要再加个发凭据的接口；先用长期密码跑通，安全加固作为后续。
