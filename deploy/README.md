# 部署（阿里云 ECS · Ubuntu · Nginx）

两个站点共用一台 ECS：

| 站点 | 域名 | 产物 | web root |
|---|---|---|---|
| 用户端 H5 | `zsky.com` | `frontend/dist` | `/var/www/micall` |
| 运营后台 | `admin.zsky.com` | `admin/dist` | `/var/www/micall-admin` |

nginx 模板见 `deploy/nginx/`。两个站点都需 HTTPS 才能用真麦克风/安全 Cookie；大陆 ECS 用域名
访问 80/443 通常需 ICP 备案，未备案可先用 `公网IP:高端口` 临时验证。

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

## 关于「接口配置」里的密钥

- 现在没后端：后台「接口配置」的 endpoint/key **暂存浏览器 localStorage**，仅供联调，
  **别填真实生产密钥**。
- 后端就绪后：给 admin 配 `VITE_API_BASE`、放开 `micall-admin.conf` 里的 `/admin/` 反代，
  密钥即改为存服务端、读取打码，浏览器不再留明文（CLAUDE.md 铁律2）。

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
（见 `deploy/micall-backend.service` 注释），`sudo systemctl restart micall-backend`，
再 `PYTHONPATH=src python3 -m micall.cli spike` 实测 TTFT（地基生死验证）。
