# BoomImage

BoomImage 是一个面向单用户、单机部署的高性能图床。项目当前处于早期开发阶段，已经具备通过验证的服务端骨架、SQLite 迁移、健康检查和 Docker Compose 部署结构。

完整设计参见 [PROJECT_PLAN.md](./PROJECT_PLAN.md)，协作约束参见 [AGENTS.md](./AGENTS.md)。

## 当前进度

- [x] TypeScript + Fastify 服务骨架
- [x] SQLite WAL 初始化和版本化迁移
- [x] `/health/live` 和 `/health/ready`
- [x] Dockerfile、Compose 和 Caddy 静态媒体路由
- [x] 管理员初始化、Argon2id 登录会话和 CSRF 防护
- [x] 流式图片上传、解码校验和内容哈希去重
- [x] Sharp AVIF/WebP 转换 Worker、任务租约和失败重试
- [x] React 管理界面、上传进度、粘贴上传和链接复制
- [x] 图片删除和失败转换重试
- [x] 可撤销 API Token 与 Bearer 上传
- [x] 一致性数据库和媒体备份命令
- [x] 登录限流和基础安全响应头
- [x] 超时临时文件安全清理
- [x] GitHub Actions 自动验证和 GHCR 镜像构建

## Docker 启动

1. 复制环境变量模板：

   ```bash
   cp .env.example .env
   ```

2. 修改 `.env` 中的 `APP_SECRET`。生产环境还应将 `APP_ADDRESS` 和 `APP_BASE_URL` 改成实际域名，并将 `BOOMIMAGE_IMAGE` 改成你的 GHCR 镜像，例如 `ghcr.io/<owner>/<repo>:latest`。

3. 拉取 GitHub Actions 构建好的镜像并启动：

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. 检查服务：

   ```bash
   curl http://localhost/health/ready
   ```

开发环境默认使用 HTTP。将 `APP_ADDRESS` 设置为实际域名后，Caddy 会负责 HTTPS。

如果确实需要临时在本机构建镜像，可以显式使用本地构建覆盖文件：

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## GitHub Actions 构建镜像

仓库包含两个 workflow：

- `.github/workflows/ci.yml`：在 PR 和 `main/master` 推送时运行类型检查、测试和生产构建。
- `.github/workflows/docker.yml`：在 PR 时只构建 Docker 镜像；在 `main/master` 推送、`v*` tag 或手动触发时，将镜像推送到 GHCR。

默认镜像名为：

```text
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:sha-<commit>
ghcr.io/<owner>/<repo>:<branch-or-tag>
```

使用 GHCR 时，请在 GitHub 仓库的 `Settings -> Actions -> General -> Workflow permissions` 中确认 workflow 具有写入 Packages 的权限。

## 本地开发

需要 Node.js 22.16 或更高版本，并通过 Corepack 使用 pnpm：

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

API 服务默认监听 `http://localhost:3000`，Vite 管理界面监听 `http://localhost:5173`。生产构建后，Fastify 会直接从 `http://localhost:3000` 提供管理界面。本地数据写入 `./data`。

### 本地启动

```bash
pnpm build
pnpm start
```

首次访问 `http://localhost:3000` 时会进入管理员初始化页面。

## 数据目录

```text
data/
├─ boomimage.db
├─ tmp/
├─ originals/
└─ variants/
```

不要只复制正在写入的 `boomimage.db` 主文件；请使用下方备份命令生成一致性快照。

## API Token 上传

登录管理界面后，点击右上角的 `API Token` 创建令牌。令牌明文只显示一次。

```bash
curl -X POST http://localhost:3000/api/v1/images \
  -H "Authorization: Bearer bi_your_token" \
  -F "file=@photo.jpg"
```

Token 仅保存 SHA-256 摘要，可以随时从管理界面撤销。

## 安全默认值

- 管理员密码使用 Argon2id 哈希保存。
- Cookie 登录使用 `HttpOnly` 会话 Cookie 和双提交 CSRF Token。
- 登录和初始化接口有固定窗口限流，默认 15 分钟最多 10 次尝试。
- API Token 仅保存 SHA-256 摘要，撤销后立即失效。
- 默认启用 CSP、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 和 `Permissions-Policy`。
- 当 `APP_BASE_URL` 使用 HTTPS 时自动启用 HSTS。
- 上传和转换临时文件写入 `APP_DATA_DIR/tmp`，默认保留 24 小时；后台维护任务默认每小时清理一次过期普通文件，不递归、不跟随目录或链接。可通过 `TMP_FILE_TTL_SECONDS` 和 `TMP_CLEANUP_INTERVAL_SECONDS` 调整，后者设为 `0` 可关闭定时清理。

## 备份

先完成生产构建，再执行：

```bash
pnpm build
pnpm backup -- ./backups
```

备份目录包含一致性 SQLite 快照、原图、所有变体和 `manifest.json`。备份期间命令会短暂持有 SQLite 写锁，因此上传和转换状态更新可能等待，但媒体读取不受影响。

恢复时停止 BoomImage，将备份中的 `boomimage.db`、`originals` 和 `variants` 放回 `APP_DATA_DIR`，确认文件权限后重新启动。恢复前应先保留当前数据目录副本。
