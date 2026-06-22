# BoomImage

BoomImage 是一个面向单用户、单机部署的高性能图床。它保留原图，并在后台异步生成 AVIF、WebP 和缩略图；普通媒体读取由 Caddy 直接提供，不经过 Node.js 实时转换。

完整设计参见 PROJECT_PLAN.md，协作约束参见 AGENTS.md。

## 当前状态

- Fastify + TypeScript 服务端
- React + Vite + Tailwind CSS 管理界面
- SQLite WAL 和版本化迁移
- 单管理员初始化、登录会话和 CSRF 防护
- 流式上传、解码校验、SHA-256 去重
- Sharp/libvips 异步生成 AVIF、WebP 和缩略图
- 本地存储 + 可选 S3 兼容存储，上传时可选 S3 直链或服务器代理
- S3 媒体会在数据库中保存实际 bucket、object key、Endpoint 和公开基址快照，后续修改默认 S3 位置配置不会让旧图片漂移到新位置
- SQLite 持久化任务队列、租约、重试和恢复
- API Token 上传
- 一致性备份命令
- 安全响应头、登录限流、临时文件清理
- GitHub Actions 自动验证和 GHCR 镜像构建

## 生产部署概览

推荐部署链路：

~~~text
GitHub Actions 构建镜像 -> GHCR 发布镜像 -> 服务器 docker compose pull -> docker compose up -d
~~~

当前默认镜像：

~~~text
ghcr.io/facjxzdt/boomimage:latest
~~~

你已经将 GHCR package 改为 public 后，服务器无需 docker login ghcr.io 也可以直接拉取镜像。

如果你只想先照着跑起来，最短路径是：

~~~bash
git clone https://github.com/facjxzdt/BoomImage.git
cd BoomImage
cp .env.example .env
nano .env
mkdir -p data backups
docker compose pull
docker compose up -d
docker compose ps
~~~

其中 `.env` 里必须把 `APP_ADDRESS`、`APP_BASE_URL` 和 `APP_SECRET` 改成自己的值。下面的章节会把每一步展开。

## 1. GitHub 侧准备

确认 GitHub Actions 已经成功构建并发布镜像：

~~~text
https://github.com/facjxzdt/BoomImage/actions
~~~

仓库包含两个 workflow：

- .github/workflows/ci.yml：类型检查、测试、生产构建。
- .github/workflows/docker.yml：构建 Docker 镜像，并在 main/master、v* tag 或手动触发时推送到 GHCR。

GHCR 镜像标签包括：

~~~text
ghcr.io/facjxzdt/boomimage:latest
ghcr.io/facjxzdt/boomimage:sha-<commit>
ghcr.io/facjxzdt/boomimage:<branch-or-tag>
~~~

你已将 GHCR package 改成 public 后，可以在服务器上直接测试匿名拉取：

~~~bash
docker pull ghcr.io/facjxzdt/boomimage:latest
~~~

能正常拉取就说明权限已经没问题；如果仍提示 `unauthorized`，通常是 GitHub package 权限还没完全生效，等一两分钟后重试。

生产环境更建议使用固定版本 tag。例如：

~~~bash
git tag v0.1.0
git push origin v0.1.0
~~~

然后服务器使用：

~~~env
BOOMIMAGE_IMAGE=ghcr.io/facjxzdt/boomimage:v0.1.0
~~~

这样回滚和排查会比一直使用 latest 更稳。

## 2. 服务器要求

建议配置：

- Linux 服务器，Debian/Ubuntu 更省心。
- 1 核 1 GB 可运行，建议至少 2 核 2 GB。
- 磁盘容量按图片规模预留，重点关注 data 目录占用。
- 已安装 Docker Engine 和 Docker Compose v2。
- 域名已解析到服务器公网 IP。
- 服务器防火墙开放 80 和 443。
- 如果服务器上已有 Nginx、宝塔、1Panel 等占用 80/443，需要先决定由谁对外提供 HTTPS，避免端口冲突。

检查 Docker：

~~~bash
docker --version
docker compose version
~~~

如果未安装 Docker，请优先按 Docker 官方文档安装。安装后可以把当前用户加入 docker 组，或者所有 docker 命令前加 sudo。

## 3. 获取部署文件

建议把项目放在固定目录，例如 `/opt/BoomImage`。如果当前用户没有 `/opt` 写权限，可以先创建目录：

~~~bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
~~~

然后克隆仓库：

~~~bash
cd /opt
git clone https://github.com/facjxzdt/BoomImage.git
cd BoomImage
~~~

如果服务器不想保留完整源码，最少需要这些文件：

~~~text
compose.yaml
.env.example
deploy/Caddyfile
~~~

但推荐直接 clone，后续更新部署文件更简单。

## 4. 配置环境变量

复制模板：

~~~bash
cp .env.example .env
~~~

编辑 .env：

~~~bash
nano .env
~~~

生产环境至少修改下面几项：

~~~env
BOOMIMAGE_IMAGE=ghcr.io/facjxzdt/boomimage:latest
APP_ADDRESS=https://img.example.com
APP_BASE_URL=https://img.example.com
APP_SECRET=replace-with-a-real-random-secret
LOG_LEVEL=info
MAX_UPLOAD_BYTES=52428800
MAX_INPUT_PIXELS=50000000
IMAGE_WORKERS=1
AVIF_QUALITY=50
AVIF_EFFORT=4
WEBP_QUALITY=82
STORAGE_DRIVER=local
~~~

变量说明：

| 变量 | 说明 |
| --- | --- |
| BOOMIMAGE_IMAGE | 要拉取的 GHCR 镜像。生产建议用固定 tag。 |
| APP_ADDRESS | Caddy 对外站点地址。正式域名用 https://img.example.com。 |
| APP_BASE_URL | API 返回图片链接时使用的公开地址，必须和访问域名一致。 |
| APP_SECRET | 会话 Cookie 签名密钥，必须是随机长字符串；生产环境缺失、模板值或明显占位值会拒绝启动。 |
| MAX_UPLOAD_BYTES | 单文件上传大小上限，默认 50 MB。 |
| MAX_INPUT_PIXELS | 图片解码像素上限，默认 50 MP。 |
| IMAGE_WORKERS | 后台转换并发。单机生产建议先用 1。 |
| AVIF_QUALITY | AVIF 输出质量，默认 50。 |
| AVIF_EFFORT | AVIF 编码 effort，默认 4。越高越慢。 |
| WEBP_QUALITY | WebP 输出质量，默认 82。 |
| TMP_FILE_TTL_SECONDS | 临时文件保留时间，默认 86400 秒。 |
| SESSION_TTL_SECONDS | 登录会话有效期，默认 2592000 秒。 |
| AUTH_RATE_LIMIT_WINDOW_MS | 登录/初始化限流窗口，默认 900000 毫秒。 |
| AUTH_RATE_LIMIT_MAX_ATTEMPTS | 限流窗口内允许的失败尝试次数，默认 10。 |
| JOB_POLL_INTERVAL_MS | Worker 空闲时轮询任务队列的间隔，默认 1000 毫秒。 |
| JOB_LEASE_SECONDS | 转换任务租约时间，默认 300 秒。机器很慢或图片很大时可适当调高。 |
| JOB_MAX_ATTEMPTS | 转换失败后的最大尝试次数，默认 3。 |
| STORAGE_DRIVER | 新上传默认存储后端，`local` 或 `s3`。管理界面上传时仍可逐张选择。 |
| S3_ACCESS_MODE | S3 新上传默认访问方式，`direct` 返回 S3/CDN 直链，`proxy` 返回 BoomImage 服务器代理链接。 |
| S3_ENDPOINT | S3 兼容服务 Endpoint。AWS S3 可留空；Cloudflare R2、MinIO 等需要填写。 |
| S3_REGION | S3 区域。Cloudflare R2 常用 `auto`。 |
| S3_BUCKET | S3 bucket 名称。使用 S3 时必填。 |
| S3_PREFIX | 对象 key 前缀，例如 `boomimage`。 |
| S3_PUBLIC_BASE_URL | S3 直链使用的公开基址，通常填 CDN 或 R2 public bucket 域名。 |
| S3_FORCE_PATH_STYLE | 是否使用 path-style 访问，MinIO 通常为 `true`。 |
| S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | S3 凭证。也兼容 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。 |

通常不需要修改 `APP_HOST`、`APP_PORT`、`APP_DATA_DIR` 和 `WEB_DIST_DIR`。在 Docker 部署里它们已经和 `compose.yaml` 对齐。

完成首次初始化后，管理界面右上角的“设置”可以修改大部分日常运行参数，并保存到 SQLite 覆盖 `.env` 默认值，包括：

- `APP_BASE_URL`
- 上传大小、解码像素、转换质量和任务重试参数
- 默认上传存储后端和 S3 访问方式
- S3 Endpoint、Region、Bucket、Prefix、CDN 公开基址和访问密钥

注意：S3 的 Bucket、Prefix、Endpoint、Region、Path Style 和公开基址会在每次上传时随图片记录固化。之后你在 UI 或 `.env` 中修改这些位置相关配置，只会影响新上传；旧图片、旧变体、S3 proxy 和删除任务会继续使用它们创建时的对象定位快照。S3 访问密钥不会随图片保存，私有 bucket 仍要求当前配置的凭证有权限访问旧 bucket。

`.env` 仍建议只管理启动级或底座配置，例如 `BOOMIMAGE_IMAGE`、`APP_ADDRESS`、`APP_SECRET`、`APP_HOST`、`APP_PORT`、`APP_DATA_DIR`、`WEB_DIST_DIR`。如果在 UI 中调大上传上限，也要同步调大 Nginx 的 `client_max_body_size` 或其他前置代理限制。

生成 APP_SECRET：

~~~bash
openssl rand -base64 48
~~~

如果还没有域名，只想本机测试，可以临时使用：

~~~env
APP_ADDRESS=http://localhost
APP_BASE_URL=http://localhost
~~~

正式上线前，请确保 DNS 已经解析到服务器，并且 80/443 端口可访问。Caddy 会自动申请和续期 HTTPS 证书。

如果使用 Cloudflare，建议先关闭橙色云代理或使用“完全/严格”TLS 模式，等源站证书签发成功后再按你的网络策略开启代理。

### 可选：启用 S3 兼容存储

BoomImage 默认继续使用本地磁盘。你也可以配置 S3 兼容对象存储，并在上传时选择“本地”或“S3”。

S3 有两种访问方式：

- `direct`：返回 S3/CDN 直链，媒体流量不经过 BoomImage，性能最好。
- `proxy`：返回 `https://img.example.com/media/proxy/...`，由 BoomImage 从 S3 读取后转发，适合 bucket 不公开或暂时没有 CDN 的场景，但会消耗服务器带宽。

示例配置：

~~~env
STORAGE_DRIVER=local
S3_ACCESS_MODE=direct
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=boomimage
S3_PREFIX=boomimage
S3_PUBLIC_BASE_URL=https://cdn.example.com
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
~~~

如果希望默认上传到 S3，把 `STORAGE_DRIVER=s3`。如果只是偶尔上传到 S3，保持 `STORAGE_DRIVER=local`，在管理界面上传前选择 S3 即可。

S3 配置的一个重要行为是“按上传固化”：图片写入 S3 时，BoomImage 会把实际 bucket、object key、Endpoint、Region、公开基址和 path-style 设置保存到 SQLite。这样以后你调整默认 `S3_PREFIX` 或换 CDN 域名时，旧图片仍会按创建时的位置生成直链、代理读取和删除清理。这里不保存访问密钥；如果旧 bucket 是私有的，切换账号或密钥前必须确认新凭证仍有旧 bucket 的 `GetObject` / `DeleteObject` 权限。要把旧对象迁移到新 bucket，需要先用对象存储工具复制对象，再规划数据库记录迁移，不要依赖启动时自动回填。

## 5. 启动服务

创建数据目录：

~~~bash
mkdir -p data
~~~

检查 Compose 配置是否能正确展开环境变量：

~~~bash
docker compose config
~~~

拉取镜像：

~~~bash
docker compose pull
~~~

启动：

~~~bash
docker compose up -d
~~~

首次启动时会自动创建 SQLite 数据库、执行迁移，并启动后台转换 Worker。

查看容器状态：

~~~bash
docker compose ps
~~~

查看日志：

~~~bash
docker compose logs -f app
docker compose logs -f caddy
~~~

健康检查：

~~~bash
curl http://localhost/health/ready
~~~

如果已经配置域名：

~~~bash
curl https://img.example.com/health/ready
~~~

正常返回：

~~~json
{"status":"ready"}
~~~

`/health/ready` 会检查 SQLite、临时目录可写性，并实际验证 Sharp/libvips 能否编码 AVIF 和 WebP。若镜像或运行环境缺少对应能力，app 会拒绝进入 ready，避免上传后 Worker 才失败。

如果 `docker compose ps` 里 app 是 `unhealthy`，优先看：

~~~bash
docker compose logs --tail=200 app
~~~

## 6. 使用 Nginx 作为前置反向代理

如果服务器上已经有 Nginx、宝塔或 1Panel，推荐让 Nginx 对公网监听 80/443，再把请求转发给 BoomImage 自带的 Caddy。这个结构是：

~~~text
公网用户 -> Nginx HTTPS -> 127.0.0.1:8080 -> Caddy -> app / 本地媒体文件
~~~

这样做的好处是：Nginx 继续统一管理证书和站点入口，BoomImage 仍然可以通过 Caddy 高效直出本地 `/media/originals/*` 和 `/media/variants/*`，S3 proxy 的 `/media/proxy/*` 也会正确转发到应用。

先在 `.env` 中设置：

~~~env
APP_ADDRESS=:80
APP_BASE_URL=https://img.example.com
CADDY_HTTP_BIND=127.0.0.1:8080
CADDY_HTTPS_BIND=127.0.0.1:8443
CADDY_HTTPS_UDP_BIND=127.0.0.1:8443
~~~

其中 `APP_BASE_URL` 必须是用户最终访问的 HTTPS 域名。`APP_ADDRESS=:80` 表示 Caddy 在容器内只按 HTTP 站点工作，不负责公网证书。

然后重启 BoomImage：

~~~bash
docker compose up -d
~~~

Nginx 示例配置：

~~~nginx
server {
    listen 80;
    server_name img.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name img.example.com;

    ssl_certificate /etc/letsencrypt/live/img.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/img.example.com/privkey.pem;

    client_max_body_size 50m;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }

    location /api/v1/images {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
~~~

注意：

- `client_max_body_size` 应不小于 `.env` 中的 `MAX_UPLOAD_BYTES`。默认 50 MB 时写 `50m` 即可。
- `/api/v1/images` 建议关闭 `proxy_request_buffering`，减少上传大图时 Nginx 的临时文件缓冲。
- 不要让 Nginx 和 Caddy 同时抢占公网 80/443；使用上面的回环绑定后，Caddy 只监听 `127.0.0.1:8080`。
- 如果启用 S3 proxy，`/media/proxy/*` 不要改写到本地静态目录，它必须经过 BoomImage 应用鉴别数据库路径后再代理 S3 对象。

配置后验证：

~~~bash
curl -I https://img.example.com/health/ready
curl -I https://img.example.com/media/originals/替换成实际路径
~~~

本地媒体响应头应包含：

~~~text
cache-control: public, max-age=31536000, immutable
cross-origin-resource-policy: cross-origin
~~~

## 7. 首次初始化

浏览器打开：

~~~text
https://img.example.com
~~~

第一次访问会进入管理员初始化页面。设置管理员密码后即可上传图片。

建议管理员密码：

- 至少 12 个字符。
- 不要和其他站点复用。
- 保存到密码管理器。

## 8. 验证上传和静态读取

登录后可以先打开右上角“设置”，确认公开访问地址、默认存储策略和 S3 参数是否正确。Secret Access Key 和 Session Token 只显示“是否已配置”，不会回显明文；留空表示不修改，勾选清空才会删除。

登录管理界面后上传一张图片。上传区上方可以选择存储策略：

- 本地：原图和变体写入 `data/originals`、`data/variants`，媒体由 Caddy 或 Nginx 静态直出。
- S3 直链：原图和变体写入 S3，复制出的链接使用 `S3_PUBLIC_BASE_URL` 或 S3 endpoint。
- S3 服务器代理：原图和变体写入 S3，复制出的链接是 `/media/proxy/...`，由 BoomImage 转发。

本地存储转换完成后，复制图片链接，确认链接类似：

~~~text
https://img.example.com/media/variants/ab/cd/<hash>/display.webp
~~~

媒体文件应该由 Caddy 直接读取，不经过 Fastify 实时转换。

可以用响应头确认静态读取是否正常：

~~~bash
curl -I https://img.example.com/media/variants/ab/cd/<hash>/display.webp
~~~

正常情况下会看到类似：

~~~text
HTTP/2 200
cache-control: public, max-age=31536000, immutable
~~~

也可以用 API Token 上传：

1. 在管理界面创建 API Token。
2. 执行：

   ~~~bash
   curl -X POST https://img.example.com/api/v1/images \
     -H "Authorization: Bearer bi_your_token" \
     -F "file=@photo.jpg"
   ~~~

Token 明文只显示一次，服务端只保存 SHA-256 摘要。

API Token 上传也可以指定存储策略：

~~~bash
curl -X POST https://img.example.com/api/v1/images \
  -H "Authorization: Bearer bi_your_token" \
  -F "storage=s3" \
  -F "access=direct" \
  -F "file=@photo.jpg"
~~~

`storage` 可选 `local` 或 `s3`；`access` 只对 S3 生效，可选 `direct` 或 `proxy`。

删除图片时，BoomImage 会先把图片标记为不可见，并立即同步尝试删除本地文件或 S3 对象：如果公开媒体本轮已经清理完成，接口返回 `204`；如果清理失败，接口返回 `202`，并保留持久化 `delete_files` 任务继续后台重试。删除任务尚未完成前，重复上传完全相同的文件可能返回 `IMAGE_DELETE_PENDING`；如果此前清理任务已经失败并耗尽重试，重复上传会自动把清理任务重新排队并返回 `IMAGE_DELETE_REQUEUED`，稍后重试即可。

## 9. 更新版本

升级前建议先做一次备份：

~~~bash
mkdir -p backups
docker compose run --rm \
  -v "$(pwd)/backups:/backups" \
  app node apps/server/dist/cli.js backup /backups
~~~

如果使用 latest：

~~~bash
docker compose pull
docker compose up -d
~~~

如果使用固定 tag：

1. GitHub 上推送新 tag，例如 v0.1.1。
2. 等 GitHub Actions 镜像构建成功。
3. 修改服务器 .env：

   ~~~env
   BOOMIMAGE_IMAGE=ghcr.io/facjxzdt/boomimage:v0.1.1
   ~~~

4. 执行：

   ~~~bash
   docker compose pull
   docker compose up -d
   ~~~

查看当前运行镜像：

~~~bash
docker compose images
~~~

如果新版本有问题，最稳的回滚方式是把 `.env` 中的 `BOOMIMAGE_IMAGE` 改回上一个固定 tag，然后执行：

~~~bash
docker compose pull
docker compose up -d
~~~

如果一直使用 `latest`，回滚会更麻烦，需要手动指定旧的 `sha-<commit>` 镜像标签，所以生产环境更推荐固定版本 tag。

## 10. 数据目录和备份

生产数据都在仓库目录下的 data：

~~~text
data/
├─ boomimage.db
├─ boomimage.db-wal
├─ boomimage.db-shm
├─ tmp/
├─ originals/
└─ variants/
~~~

不要在服务运行时只复制 boomimage.db 主文件。SQLite WAL 模式下，boomimage.db-wal 也可能包含尚未 checkpoint 的数据。

如果使用 S3 存储，内置备份只会备份 SQLite 数据库和本地 `originals/variants` 文件；S3 bucket 中的对象需要使用云厂商生命周期、版本控制或单独的对象存储备份策略。SQLite 里保存的是对象 key、bucket、Endpoint、公开基址、存储后端和访问模式，因此恢复数据库时也要确保对应 S3 对象仍然存在。

推荐使用内置备份命令。因为当前部署使用容器镜像，可以用一次性容器把备份写到宿主机 backups 目录：

~~~bash
mkdir -p backups
docker compose run --rm \
  -v "$(pwd)/backups:/backups" \
  app node apps/server/dist/cli.js backup /backups
~~~

备份目录会包含：

~~~text
boomimage-<timestamp>/
├─ boomimage.db
├─ originals/
├─ variants/
└─ manifest.json
~~~

建议用 cron 每天备份一次，并把 backups 目录同步到另一台机器或对象存储。示例：

~~~cron
15 3 * * * cd /opt/BoomImage && docker compose run --rm -v "$(pwd)/backups:/backups" app node apps/server/dist/cli.js backup /backups
~~~

备份完成后，建议至少偶尔在另一台机器上做恢复演练。备份只有真的恢复过，心里才踏实。

恢复时：

1. 停止服务：

   ~~~bash
   docker compose down
   ~~~

2. 备份当前数据目录：

   ~~~bash
   mv data data.before-restore
   mkdir data
   ~~~

3. 从备份中恢复：

   ~~~bash
   cp backups/boomimage-xxxx/boomimage.db data/boomimage.db
   cp -a backups/boomimage-xxxx/originals data/originals
   cp -a backups/boomimage-xxxx/variants data/variants
   mkdir -p data/tmp
   ~~~

4. 启动：

   ~~~bash
   docker compose up -d
   ~~~

## 11. 日志和运维建议

查看实时日志：

~~~bash
docker compose logs -f
~~~

查看资源占用：

~~~bash
docker stats
~~~

建议生产服务器配置 Docker 日志轮转，避免日志占满磁盘：

~~~bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  }
}
JSON
sudo systemctl restart docker
~~~

建议监控：

- data 目录磁盘占用。
- 根分区剩余空间。
- docker compose ps 健康状态。
- data/tmp 是否异常增长。
- 转换失败数量。

性能调优建议：

- 小机器先保持 `IMAGE_WORKERS=1`，确认稳定后再加到 2。
- `AVIF_EFFORT` 越高压缩越慢，单人图床通常 4 已经比较均衡。
- 如果上传大图较多，优先增加内存和磁盘 IO，而不是盲目提高 Worker 数。
- 媒体读取由 Caddy 直出，访问量上来时瓶颈通常先出现在带宽和磁盘，而不是 Node.js。

## 12. 常见问题

### docker compose pull 提示 unauthorized

说明 GHCR package 仍是 private，或者服务器没有登录 GHCR。

如果已经将 GHCR package 改成 public，等一两分钟后重试：

~~~bash
docker compose pull
~~~

如果仍失败，可以临时登录：

~~~bash
docker login ghcr.io
~~~

用户名填 GitHub 用户名，密码使用具有 read:packages 权限的 Personal Access Token。

### Caddy 无法申请 HTTPS 证书

检查：

- 域名 A/AAAA 记录是否指向服务器。
- 服务器 80 和 443 是否开放。
- APP_ADDRESS 是否是正式域名，例如 https://img.example.com。
- 云厂商安全组是否放行 80/443。

查看 Caddy 日志：

~~~bash
docker compose logs -f caddy
~~~

### health/ready 返回 503

查看 app 日志：

~~~bash
docker compose logs -f app
~~~

常见原因：

- data 权限不对。
- SQLite 数据库无法创建或写入。
- 迁移目录缺失。
- 磁盘满。

### 上传成功但图片一直 processing

查看 app 日志：

~~~bash
docker compose logs -f app
~~~

可尝试：

- 降低 IMAGE_WORKERS=1。
- 确认服务器内存足够。
- 确认图片没有超过 MAX_INPUT_PIXELS。
- 在管理界面对失败图片点击“重新转换”。

### 访问 /media 图片 404

检查：

- 图片是否转换完成。
- data/originals 和 data/variants 是否存在。
- Caddy volume 是否正确挂载。
- URL 中 hash 路径是否完整。

### S3 上传失败

检查：

- `S3_BUCKET` 是否填写。
- `S3_ENDPOINT`、`S3_REGION` 和 `S3_FORCE_PATH_STYLE` 是否符合你的 S3 兼容服务。
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` 是否有 `PutObject`、`GetObject`、`DeleteObject` 权限。
- `S3_PREFIX` 不要以 `/` 开头或结尾；程序会自动规范化。

### S3 直链无法访问

检查：

- `S3_PUBLIC_BASE_URL` 是否是浏览器可访问的公开域名。
- bucket 或 CDN 是否允许公开读取对应对象。
- 如果不想公开 bucket，请使用 `S3_ACCESS_MODE=proxy` 或上传时选择“服务器代理”。

### S3 代理链接很慢

代理模式下图片流量会经过 BoomImage 服务器，速度取决于服务器到 S3 的链路和服务器出口带宽。公开图床更推荐 `direct` 加 CDN。

### docker compose up 提示端口被占用

说明服务器已有程序监听 80 或 443。排查：

~~~bash
sudo ss -lntp | grep -E ':80|:443'
~~~

如果已有反向代理，可以选择停掉旧服务，或者改为由旧反向代理转发到 BoomImage；后一种方式需要同步调整 `compose.yaml` 和 `deploy/Caddyfile`，不要让两个服务同时抢 80/443。

### 登录后接口提示 CSRF 或 Cookie 问题

检查：

- `APP_BASE_URL` 是否和浏览器访问地址完全一致。
- 正式 HTTPS 部署时不要用 `http://` 访问后台。
- 浏览器是否禁用了站点 Cookie。
- 如果套了额外反向代理，确认没有错误改写 `Host` 和协议头。

## 13. 生产上线前检查清单

上线前建议逐项确认：

- GHCR package 已经是 public，服务器可以匿名 `docker pull ghcr.io/facjxzdt/boomimage:latest`。
- `.env` 已设置真实 `APP_SECRET`，不是模板默认值；生产环境缺失或使用占位值会拒绝启动。
- `APP_ADDRESS` 和 `APP_BASE_URL` 都是最终访问域名。
- DNS 已解析到服务器公网 IP。
- 云厂商安全组和系统防火墙已开放 80/443。
- `docker compose ps` 中 app 和 caddy 均为正常状态。
- `https://你的域名/health/ready` 返回 `{"status":"ready"}`。
- 已完成首次管理员初始化，并把密码保存到密码管理器。
- 已上传一张测试图片，确认 `/media/...` 链接可访问。
- 如果启用 S3，已分别测试 S3 直链或 `/media/proxy/...` 代理链接。
- 已执行一次备份命令，并确认 backups 目录生成了备份。
- 已规划定时备份和异地同步。

## 14. 本地开发

本地开发需要 Node.js 22.16 或更高版本，并通过 pnpm workspace 运行：

~~~bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm dev
~~~

API 服务默认监听：

~~~text
http://localhost:3000
~~~

Vite 管理界面默认监听：

~~~text
http://localhost:5173
~~~

生产构建后，本地也可以直接运行：

~~~bash
pnpm build
pnpm start
~~~

如果确实需要在本机构建 Docker 镜像，可以显式使用本地构建覆盖文件：

~~~bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
~~~

默认 compose.yaml 不会本地构建镜像，而是拉取 BOOMIMAGE_IMAGE 指定的 GHCR 镜像。
