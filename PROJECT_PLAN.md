# BoomImage 项目规划

> 面向单用户、单机 Docker 部署的高性能图床。支持自动生成 AVIF、WebP 等图片变体；默认使用本地文件系统，也可按上传选择 S3 兼容对象存储，并支持对象存储/CDN 直链或 BoomImage 服务器代理访问。

## 实施状态

更新时间：2026-06-22

- M0 已完成：pnpm workspace、TypeScript/Fastify 服务骨架、配置校验、SQLite WAL、首个数据库迁移、健康检查、基础测试、Dockerfile、Compose、Caddyfile 和 README 均已落地。
- 数据库驱动使用 Node.js 内置的 `node:sqlite`，最低 Node.js 版本为 22.16，从而避免本地原生模块编译依赖并支持 SQLite Backup API。
- 已在 Node.js 24.17.0 下通过 TypeScript 类型检查、4 项测试、生产构建，并对编译产物执行健康检查冒烟测试；当前环境仍未提供 Docker，因此容器构建尚未实测。
- M1 已完成核心闭环：单管理员初始化、Argon2id 密码、持久化会话、CSRF 防护、流式上传、文件头与解码双重校验、SHA-256 去重、图片列表和详情 API。
- 已在 Node.js 24.17.0 下通过 TypeScript 类型检查、8 项测试和生产构建。Docker 验证按用户要求暂缓，不作为本地开发阻塞项。
- M2 已完成：SQLite 任务租约、过期任务回收、并发受控的后台 Worker、Sharp 自动旋转与缩放、AVIF/WebP 原子输出、指数退避和最多三次重试均已实现。
- 已通过 10 项测试，覆盖真实 AVIF/WebP 文件生成、任务完成、租约恢复、原图丢失、最终失败和错误路径脱敏；TypeScript 类型检查与生产构建通过。
- M3 核心已完成：React/Vite 管理端支持首次初始化、登录恢复、拖拽/选择/剪贴板上传、实时进度、转换状态轮询、响应式图片网格、原图/Markdown/HTML 链接复制、失败重试和安全删除。
- Fastify 可在无 Docker 环境下直接提供管理端和 `/media/originals`、`/media/variants` 静态文件；前后端类型检查、11 项服务端测试、双端生产构建和本地 HTTP 静态资源冒烟测试均通过。
- M4 核心已完成：个人 API Token 支持创建、只显示一次、SHA-256 摘要存储、使用时间追踪和即时撤销；Bearer 请求可调用图片 API，但不能管理其他 Token。
- 已实现基于 SQLite Backup API 的一致性备份命令，备份期间使用独立写锁连接冻结数据库写入，并复制原图、变体和版本化 manifest；恢复流程已写入 README。
- 完整回归现为 13 项测试，双端类型检查与生产构建均通过。Vite 改用模块运行器加载配置，本地构建不再需要访问工作区上级目录。
- 发布前安全加固已推进：登录/初始化固定窗口限流、CSP、HSTS 条件启用、`nosniff`、`DENY` frame 防护、Referrer 与 Permissions Policy 已实现。
- 临时文件清理已实现：上传和转换临时文件统一写入 `data/tmp`，后台维护任务定期清理过期普通文件，清理前进行目录边界校验，不递归、不跟随目录或链接。
- CI/CD 已添加：GitHub Actions 负责类型检查、测试、生产构建，以及在 GitHub 上构建并推送 GHCR Docker 镜像；本地 `compose.yaml` 默认拉取远程镜像，`compose.build.yaml` 仅作为显式本地构建覆盖文件。
- S3 兼容存储已实现：上传时可选 `local` 或 `s3`，S3 媒体可选对象存储/CDN 直链或 `/media/proxy/*` 服务器代理；Worker 可从 S3 取回原图生成变体并写回同一存储后端；图片和变体会保存实际 bucket、object key、Endpoint、Region、公开基址和 path-style 快照，后续修改默认 S3 位置配置不会让旧对象漂移；私有 bucket 仍要求当前凭证有权限访问旧对象。
- 管理界面运行设置已实现：管理员可在 UI 中修改公开地址、上传/解码限制、转换质量、默认存储策略和 S3 连接信息；设置保存到 SQLite 的 `app_settings` 并覆盖 `.env` 默认值，启动级配置仍由 `.env` 管理。
- 删除流程已改为软删除加同步物理清理优先，并保留持久化 `delete_files` 任务兜底重试；公开媒体本轮清理成功返回 `204`，失败则返回 `202` 并后台继续清理；失败删除任务在同内容重复上传时会自动重新排队，避免哈希永久阻塞；会话 Cookie 已接入 `APP_SECRET` 签名，生产环境拒绝公开默认密钥。
- 错误响应已统一脱敏：未捕获异常只记录到服务端日志，客户端收到稳定错误结构；启动和 `/health/ready` 会实际验证 Sharp/libvips 的 AVIF 与 WebP 编码能力。
- 当前完整回归为 38 项服务端测试，前后端类型检查和前后端生产构建均通过。
- 下一步建议执行：真实浏览器视觉走查、上传压测、备份恢复演练、Windows/Linux 路径兼容复查和首个版本发布。

## 1. 项目目标

- 使用 `docker compose up -d` 完成部署。
- 上传原图后，后台自动生成 AVIF、WebP 和缩略图。
- 图片读取不触发实时转换，保证低延迟和高并发读取。
- 当前只支持一个管理员，不实现多用户、配额和复杂权限系统。
- 原图始终保留，转换失败不能影响原图可用性。
- 默认本地存储的数据可以通过备份一个宿主机目录完成迁移和恢复；S3 对象需要使用对象存储自身的版本控制、复制或备份策略。

## 2. 非目标

第一版不实现：

- 多用户注册、团队、角色权限和计费。
- Kubernetes、微服务、Redis、MinIO 或 PostgreSQL。
- 任意 URL 参数动态裁剪、缩放或转换。
- 在线图片编辑器和复杂相册系统。
- 动图到 AVIF/WebP 动图的自动转换。

## 3. 技术选型

| 模块 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js LTS + TypeScript | 开发效率高，单用户场景性能充足 |
| HTTP API | Fastify | 轻量，适合流式上传和结构化校验 |
| 图片处理 | Sharp/libvips | 支持 AVIF、WebP、JPEG、PNG 等输出 |
| 数据库 | SQLite（WAL） | 保存元数据和持久化任务队列 |
| 文件存储 | 本地文件系统 + 可选 S3 兼容存储 | 图片二进制不存入 SQLite，可按上传选择后端 |
| 管理界面 | React + Vite + Tailwind CSS | 构建后作为静态资源发布 |
| 网关 | Caddy | HTTPS、API 反向代理、媒体文件静态服务 |
| 部署 | Docker Compose | `app + caddy` 两个容器 |
| 测试 | Vitest + Fastify inject | 单元测试和 API 集成测试 |

参考资料：

- [Sharp AVIF 输出](https://sharp.pixelplumbing.com/api-output/#avif)
- [Sharp 并发配置](https://sharp.pixelplumbing.com/api-utility/#concurrency)
- [Caddy file_server](https://caddyserver.com/docs/caddyfile/directives/file_server)
- [SQLite WAL](https://sqlite.org/wal.html)

## 4. 总体架构

```text
浏览器 / API 客户端 / PicGo
             │
        Caddy / Nginx
      ┌──────┴─────────┐
      │                │
 /api、管理页面     /media/*
      │                ├── 本地静态文件直出
 Fastify 应用       └── S3 proxy 反代到应用
      │
      ├── SQLite：图片、变体、任务、令牌、存储后端
      ├── 本地磁盘：原图和变体
      ├── S3 兼容对象存储：原图和变体
      └── 后台 Worker：Sharp/libvips
```

核心原则：

1. 上传路径和读取路径分离。
2. 上传流式落盘，不把整个文件保存在应用内存中。
3. 转换异步执行，任务状态持久化到 SQLite。
4. 本地媒体由 Caddy/Nginx 直接读取；S3 媒体可返回对象存储/CDN 直链，或通过 BoomImage 代理读取。
5. 文件和 S3 object key 采用内容哈希寻址，并设置长期不可变缓存。

## 5. 建议仓库结构

```text
BoomImage/
├─ apps/
│  ├─ server/              # Fastify API、Worker、CLI
│  └─ web/                 # React 管理界面
├─ packages/
│  └─ shared/              # DTO、常量、共享类型
├─ migrations/             # SQLite 数据库迁移
├─ deploy/
│  ├─ Caddyfile
│  └─ entrypoint.sh
├─ data/                    # 本地开发数据，不提交 Git
├─ Dockerfile
├─ compose.yaml
├─ package.json
├─ pnpm-workspace.yaml
├─ .env.example
└─ PROJECT_PLAN.md
```

若第一阶段希望减少工程复杂度，也可以先将 `server` 和 `web` 放在同一应用中，但存储、转换器和 API 仍需保持模块边界。

## 6. 数据目录

生产环境将宿主机的 `./data` 挂载到应用的 `/data`：

```text
data/
├─ boomimage.db
├─ boomimage.db-wal
├─ boomimage.db-shm
├─ tmp/
├─ originals/ab/cd/<sha256>.<ext>
└─ variants/ab/cd/<sha256>/
   ├─ display.avif
   ├─ display.webp
   ├─ thumb.avif
   └─ thumb.webp
```

- `ab/cd` 取 SHA-256 前四位，用于避免单目录文件过多。
- 临时文件与最终文件必须处于同一文件系统，以支持原子重命名。
- Caddy 只读挂载 `originals` 和 `variants`。
- 数据库只存路径和元数据，不存图片 BLOB。
- S3 模式下数据库保存对象 key、bucket、Endpoint、Region、公开基址、path-style、存储后端和访问模式；对象 key 仍由服务端根据内容哈希生成，并在上传时固化到图片和变体记录，避免后续修改默认 S3 位置配置导致旧对象定位漂移。数据库不保存访问密钥，S3 proxy、Worker 读取和删除清理使用当前凭证，因此更换账号或密钥前必须确认新凭证仍可访问旧 bucket。

## 7. 上传和转换流程

1. 鉴权并检查请求大小。
2. 将 multipart 文件流写入 `/data/tmp`，同时计算 SHA-256。
3. 通过文件内容识别 MIME，不相信客户端扩展名。
4. 使用 Sharp 读取宽高、方向、透明通道、页数等信息。
5. 检查文件大小、像素数、格式和动图限制。
6. 如果哈希已存在，返回已有图片记录，实现去重。
7. 原子移动原图，并在一个事务中创建图片和转换任务。
8. API 返回 `202 Accepted` 以及图片 ID、状态查询地址。
9. Worker 领取任务，生成临时变体，成功后原子重命名。
10. 所有目标变体生成后，将图片状态更新为 `ready`；部分失败则标记为 `partial`。

Worker 必须具备：

- SQLite 持久化任务队列，不引入 Redis。
- 任务租约和超时回收，进程崩溃后可以重新执行。
- 有限重试，例如最多 3 次并记录最后错误。
- 幂等输出，相同任务重复执行不会产生脏数据。
- 可配置并发，默认 `max(1, floor(CPU 核心数 / 2))`。
- 收到退出信号后停止领取新任务，并等待当前任务结束。

## 8. 默认转换策略

第一版建议固定转换档案，不提供任意动态参数：

| 名称 | 尺寸 | 格式 | 初始参数 |
| --- | --- | --- | --- |
| original | 原始尺寸 | 原格式 | 原样保留 |
| display | 最大宽度 2560px | AVIF | quality 50，effort 4 |
| display | 最大宽度 2560px | WebP | quality 82 |
| thumb | 最大宽度 480px | AVIF | quality 45，effort 4 |
| thumb | 最大宽度 480px | WebP | quality 78 |

处理规则：

- 使用 EXIF 方向自动旋转后再输出。
- 默认移除 EXIF、GPS 和其他隐私元数据。
- 不放大小于目标尺寸的图片。
- 保留透明通道。
- GIF 等动图第一版仅保存原图，并在界面中提示未生成变体。
- SVG 第一版仅保存，不自动栅格化；必须单独评估安全策略后才能开放。
- 各格式是否可用应在应用启动时检测，不能只依赖文件扩展名或配置假设。

## 9. 数据模型

### images

```text
id                  TEXT PRIMARY KEY       # ULID
sha256              TEXT UNIQUE NOT NULL
original_name       TEXT NOT NULL
original_mime       TEXT NOT NULL
original_ext        TEXT NOT NULL
original_path       TEXT NOT NULL
width               INTEGER NOT NULL
height              INTEGER NOT NULL
size_bytes          INTEGER NOT NULL
has_alpha           INTEGER NOT NULL
is_animated         INTEGER NOT NULL
status              TEXT NOT NULL          # pending|processing|ready|partial|failed
storage_driver      TEXT NOT NULL          # local|s3
access_mode         TEXT NOT NULL          # direct|proxy
s3_bucket           TEXT NULL
s3_object_key       TEXT NULL
s3_endpoint         TEXT NULL
s3_region           TEXT NULL
s3_public_base_url  TEXT NULL
s3_force_path_style INTEGER NULL           # 0|1
created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL
deleted_at          TEXT NULL
```

### variants

```text
id                  TEXT PRIMARY KEY
image_id            TEXT NOT NULL
profile             TEXT NOT NULL          # display|thumb
format              TEXT NOT NULL          # avif|webp
path                TEXT NOT NULL
width               INTEGER NULL
height               INTEGER NULL
size_bytes          INTEGER NULL
status              TEXT NOT NULL          # pending|ready|failed
error               TEXT NULL
s3_bucket           TEXT NULL
s3_object_key       TEXT NULL
s3_endpoint         TEXT NULL
s3_region           TEXT NULL
s3_public_base_url  TEXT NULL
s3_force_path_style INTEGER NULL           # 0|1
created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL
UNIQUE(image_id, profile, format)
```

### jobs

```text
id                  TEXT PRIMARY KEY
type                TEXT NOT NULL          # generate_variants|delete_files
image_id            TEXT NOT NULL
state               TEXT NOT NULL          # pending|running|succeeded|failed
attempts            INTEGER NOT NULL
available_at        TEXT NOT NULL
lease_until         TEXT NULL
worker_id           TEXT NULL
last_error          TEXT NULL
created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL
```

### api_tokens

```text
id                  TEXT PRIMARY KEY
name                TEXT NOT NULL
token_hash          TEXT UNIQUE NOT NULL
last_used_at        TEXT NULL
expires_at          TEXT NULL
created_at          TEXT NOT NULL
revoked_at          TEXT NULL
```

数据库还需要保存管理员密码哈希、应用配置版本和迁移版本。密码使用 Argon2id；API Token 只在创建时展示明文。

## 10. API 草案

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/me

POST   /api/v1/images
GET    /api/v1/images
GET    /api/v1/images/:id
DELETE /api/v1/images/:id
POST   /api/v1/images/:id/retry

GET    /api/v1/tokens
POST   /api/v1/tokens
DELETE /api/v1/tokens/:id

GET    /health/live
GET    /health/ready
```

上传成功响应应包含：

- 图片 ID、处理状态和原始信息。
- 原图、AVIF、WebP、缩略图 URL；尚未生成的 URL 标记为 pending。
- Markdown、HTML 等展示字符串可以由前端根据 URL 生成，不必存入数据库。

## 11. URL 和缓存

建议公开地址：

```text
/media/originals/ab/cd/<sha256>.jpg
/media/variants/ab/cd/<sha256>/display.avif
/media/variants/ab/cd/<sha256>/display.webp
```

内容哈希变化意味着 URL 变化，因此可以设置：

```text
Cache-Control: public, max-age=31536000, immutable
```

- 图片文件名不包含用户提供的原文件名。
- 第一版由上传接口返回明确的格式 URL，前端使用 `<picture>` 选择 AVIF/WebP。
- 暂不实现 `Accept` 协商端点，避免每个图片请求进入应用。
- 已压缩图片无需再进行 gzip 或 zstd 压缩。

## 12. 鉴权与安全

- 公开读取图片；上传、删除、列表和管理操作必须鉴权。
- 管理页面使用安全 Cookie：`HttpOnly`、`Secure`、`SameSite=Strict`。
- Cookie 鉴权的写操作需要 CSRF 防护。
- API 客户端使用 Bearer Token。
- 默认最大上传文件 50 MB，默认最大解码像素 50 MP，均允许配置。
- 限制 multipart 字段数量、文件数量、请求超时和上传速率。
- 验证 magic bytes、解码结果和文件扩展名的一致性。
- 所有数据库语句参数化，文件路径只能由服务端生成。
- 错误响应不能暴露真实磁盘路径、堆栈、密码哈希、S3 密钥或 Token；未捕获异常应记录到服务端日志，客户端只返回稳定错误码。
- 定期清理超时临时文件，但只能清理 `/data/tmp` 内经过校验的路径。
- 容器使用非 root 用户；Caddy 对媒体目录只读。

## 13. Docker 部署

`compose.yaml` 计划包含：

### app

- 暴露内部端口 `3000`，不直接映射公网。
- `/data` 读写挂载。
- 健康检查访问 `/health/ready`。
- `restart: unless-stopped`。
- 处理 SIGTERM，优雅关闭 API 和 Worker。
- 默认使用 `BOOMIMAGE_IMAGE` 指定的 GHCR 镜像；本地 Docker 构建只通过 `compose.build.yaml` 显式启用。

### caddy

- 对外暴露 `80/443`。
- `/api/*` 和管理页面反向代理至 app。
- `/media/*` 从只读目录直接提供。
- 保存 Caddy 证书数据卷。
- 对内容哈希文件设置长期缓存头。

### 环境变量草案

```text
APP_BASE_URL=https://img.example.com
BOOMIMAGE_IMAGE=ghcr.io/owner/boomimage:latest
APP_DATA_DIR=/data
APP_SECRET=<随机长密钥>
ADMIN_PASSWORD=<首次启动密码>
MAX_UPLOAD_BYTES=52428800
MAX_INPUT_PIXELS=50000000
TMP_FILE_TTL_SECONDS=86400
TMP_CLEANUP_INTERVAL_SECONDS=3600
IMAGE_WORKERS=2
AVIF_QUALITY=50
AVIF_EFFORT=4
WEBP_QUALITY=82
```

首次启动密码只能用于引导管理员账户；完成初始化后不应继续依赖环境变量中的明文密码。

## 14. 管理界面 MVP

- 登录。
- 拖拽、文件选择和剪贴板粘贴上传。
- 显示上传进度和转换状态。
- 图片分页列表、缩略图、尺寸和文件大小。
- 复制原图、AVIF、WebP、Markdown 和 HTML 链接。
- 删除图片、重试失败任务。
- 创建和撤销 API Token。

第一版不做标签、相册、搜索语法和批量编辑；可以保留简单文件名过滤。

## 15. 备份与恢复

- 图片和数据库都位于同一个 `data` 目录，但不能在数据库写入时只复制主数据库文件。
- 实现 CLI 或管理命令，通过 SQLite Backup API 或 `VACUUM INTO` 生成一致性数据库快照。
- 备份内容包括数据库快照、`originals`、`variants` 和配置说明。
- 恢复时先停止 app，恢复目录，再启动并执行完整性检查。
- 变体理论上可从原图重建，但第一版备份仍建议包含变体以缩短恢复时间。

## 16. 可观测性

- 使用结构化 JSON 日志。
- 每个请求包含 request ID。
- 记录上传耗时、转换耗时、输入输出大小、任务重试和失败原因。
- `/health/live` 只检查进程存活。
- `/health/ready` 检查数据库可读写、数据目录可用、迁移完成，以及 Sharp/libvips 是否能实际编码 AVIF 与 WebP。
- 第一版不强制接入 Prometheus，但日志字段需为后续指标化做好准备。

## 17. 测试和验收标准

### 功能验收

- JPEG、PNG、WebP、AVIF 可以上传并正确记录元数据。
- JPEG/PNG/WebP 输入能够生成指定 AVIF/WebP 变体。
- EXIF 方向正确，默认输出不包含隐私元数据。
- 相同内容重复上传不会保存第二份原图。
- 容器在转换过程中重启后，任务可以继续或安全重试。
- 删除操作不会留下数据库记录与文件状态不一致的问题。
- API Token 可以创建、使用和撤销。

### 性能与资源验收

- 上传过程采用流式落盘，应用内存不随上传文件字节数线性增长。
- 普通媒体请求由 Caddy 提供，不进入 Fastify 和 Sharp。
- 转换并发受控，不因批量上传无限创建任务或线程。
- 使用 50 MP 上限附近的测试图时，失败也必须可控，不能导致容器反复崩溃。
- 支持 `ETag` 或 `Last-Modified`，并正确返回条件请求结果。

### 安全验收

- 拒绝超出大小或像素限制的图片。
- 拒绝扩展名伪装和无法解码的内容。
- 未登录用户不能访问管理 API。
- 日志和 API 响应不出现密码、Token 或宿主机路径。
- 路径遍历输入无法访问 `/data` 之外的文件。

## 18. 实施里程碑

### M0：项目骨架

- pnpm workspace、TypeScript、Fastify、React。
- Dockerfile、Compose、Caddyfile、环境变量模板。
- SQLite 连接、迁移系统、健康检查。

### M1：上传闭环

- 管理员初始化和登录。
- 流式上传、哈希、校验、原图落盘和去重。
- 图片列表与详情 API。

### M2：转换闭环

- SQLite 任务队列、租约、重试和优雅退出。
- AVIF/WebP/缩略图生成。
- Caddy 静态文件服务和缓存规则。

### M3：管理界面

- 拖拽/粘贴上传、进度、列表和链接复制。
- 删除、失败展示和重试。
- API Token 管理。

### M4：生产加固

- 输入限制、安全头、CSRF、错误脱敏。
- 备份恢复命令。
- 单元、集成、重启恢复及性能测试。
- 部署文档和升级说明。

## 19. 后续扩展边界

实现时预留以下接口，但第一版只提供本地实现：

- `Storage`：`put`、`open`、`delete`、`exists`、`publicUrl`。
- `ImageProcessor`：探测、生成指定 profile。
- `JobQueue`：领取、续租、成功、失败、重试。

未来可以在不修改 API 语义的情况下增加：

- S3 兼容存储和 CDN。
- 新的尺寸档案和响应式图片集合。
- PicGo 插件或兼容上传协议。
- 标签、相册和搜索。
- 多用户与权限，但这需要重新设计所有权和资源隔离，不能简单加一个用户表。

## 20. 给后续 Agent 的实施约束

1. 开工前先阅读本文件，并检查已有工作区修改，不覆盖用户或其他 Agent 的变更。
2. 优先完成端到端垂直切片，不先搭建不必要的抽象层。
3. 不引入 Redis、MinIO、PostgreSQL 或动态图片处理端点，除非需求明确改变。
4. 所有媒体写入必须采用临时文件加原子重命名。
5. 所有任务必须可重试且幂等；不得只保存在进程内存中。
6. 不删除原图来节省空间；原图是恢复和重新编码的唯一可靠来源。
7. 新增依赖前说明用途，并优先选择活跃、可在目标 Docker 镜像中稳定安装的依赖。
8. 每个里程碑完成后更新本文件中的决策或偏差，并记录验证命令。
