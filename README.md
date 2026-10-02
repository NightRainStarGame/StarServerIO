# StarServerIO

> 自托管的通用应用后端中台。**部署一套服务，多个应用共用**：账号体系、文件存储、版本发行、卡密、公告、论坛、包分发。

[![CI](https://github.com/NightRainStarGame/StarServerIO/actions/workflows/ci.yml/badge.svg)](https://github.com/NightRainStarGame/StarServerIO/actions/workflows/ci.yml)

桌面应用、移动应用、小工具在做到一定阶段后，都会反复需要同一批后端能力：让用户登录、存文件、发版本、卖激活码、推公告。为每个项目各写一遍既费时又容易各写各的错。SSIO 把这些能力抽成一套可自托管的服务，一个实例服务多个应用，应用之间数据完全隔离。

技术栈：Node 22 + TypeScript，服务端 Fastify 5 + Drizzle ORM（SQLite），单体仓库（pnpm workspace）。

---

## 特性

| 能力 | 说明 |
|---|---|
| **版本发行** | 按平台 / 架构 / 渠道分发；灰度按百分比放量、可标记强制升级、可设最低版本；下载计数；下架为软删除 |
| **文件存储** | 分片上传（默认 4 MiB，支持 1–16 MiB）、断点续传、服务端校验 sha256、相同内容秒传、配额控制、时效签名下载 URL（支持 Range） |
| **卡密** | 批量生成（1 万张约 430 ms）、明文**仅在一次性导出链接中出现一次**、核销幂等（并发下只有一个"首次成功"）、可按掩码查状态 |
| **公告** | 生效时间窗由服务端判定、置顶优先、等级（info/warning/critical）、Markdown 正文 |
| **论坛** | 板块 → 帖子 → 回复；发帖与回复必须以用户身份，管理动作走应用凭证 |
| **包分发** | `名称 + 版本 + 自定义元数据` 的通用包仓库，适合插件、资源包、依赖分发 |
| **账号体系** | 应用内用户注册 / 登录 / 刷新（刷新令牌轮换制）、令牌内省接口 |
| **多应用隔离** | 所有数据按应用隔离，跨应用访问一律返回 404 |

配套：**Node / 浏览器 SDK**（含 React hooks）、**命令行工具**、**管理控制台**、**Capacitor 移动端示例**。

---

## 快速开始

```bash
corepack enable          # 或 npm i -g pnpm
pnpm install
cp .env.example .env     # 至少设置 JWT_SECRET（≥32 字符）与 MASTER_KEY（≥16 字符）
pnpm dev                 # http://127.0.0.1:8100
```

验证：

```bash
curl http://127.0.0.1:8100/v1/healthz    # {"ok":true,"version":"0.1.0","uptime":...}
curl http://127.0.0.1:8100/v1/readyz     # {"ok":true,"db":true} —— 会真查一次数据库
```

> 缺少必需环境变量或强度不达标时，服务**拒绝启动**，不提供不安全的默认值。
> 完整的十分钟上手流程见 [`docs/05-快速上手.md`](docs/05-快速上手.md)。

---

## 鉴权模型

三种凭据，各司其职：

| 通道 | 请求头 | 用途 |
|---|---|---|
| Master Key | `X-Master-Key` | 平台管理员：创建应用、签发与吊销 API Key |
| API Key | `X-API-Key` | 应用服务端：按 scope 调用业务接口 |
| 用户 JWT | `Authorization: Bearer <access>` | 终端用户：访问自己的资源 |

用户令牌由 API Key 通道签发（注册 / 登录），刷新令牌采用**轮换制**：每次刷新都颁发新令牌并作废旧令牌。业务后端需要确认令牌是否有效时，调用 `POST /v1/auth/introspect`（需 `auth:read`）。

---

## 客户端接入

**Node / Electron**

```ts
import { createClient } from '@ssio/node';

const client = await createClient({ baseUrl: 'https://ssio.example.com', apiKey: KEY });

// 检查更新
const latest = await client.releases.latest({
  platform: 'win', arch: 'x64', channel: 'stable', current: '1.2.10',
});
if (latest.hasUpdate) {
  // 流式下载，支持断点续传与 sha256 校验
  await client.downloadToFile(latest.url, './update.exe', { sha256: latest.sha256 });
}
```

**浏览器**

```ts
import { createClient } from '@ssio/web';

const client = createClient({ baseUrl: 'https://ssio.example.com', apiKey: KEY });
await client.uploadFile(file, { onProgress: (p) => console.log(p.percent) });
```

**React**

```tsx
import { useSsioUpload } from '@ssio/web/react';

const { upload, progress, status } = useSsioUpload(client);
```

SDK 体积（esbuild + minify + gzip，`pnpm sdk:size` 复测）：

| 包 | gzip | 说明 |
|---|---|---|
| `@ssio/core` | 2.22 KB | 传输层：重试退避、401 并发去重续期、429 处理、错误归一、分页迭代 |
| `@ssio/web` | 2.76 KB | localStorage 持久化 + 并发分片上传；React hooks 在 `@ssio/web/react`（0.68 KB，React 为可选 peer） |
| `@ssio/node` | — | 令牌文件持久化、流式下载（断点续传 + 校验）、`createUpdater` 更新执行器 |

---

## 命令行工具

`@ssio/cli` 提供 `ssio` 命令，便于脚本化运维；所有命令支持 `--json`：

```bash
ssio config set --url http://127.0.0.1:8100 --master-key <key>   # 写入 ~/.ssio/config.json（0600）
ssio app create myapp --name "我的应用"
ssio key issue --app myapp --scopes release:write,release:read,storage:write
ssio release publish --app myapp --version 1.0.0 --file ./Setup.exe --platform win --arch x64
ssio release list --app myapp
ssio card batch --app myapp --total 100 --days 30
ssio announce post --app myapp --title "停服维护" --content-md "..." --pinned
ssio quota --app myapp
```

环境变量 `SSIO_URL` / `SSIO_MASTER_KEY` / `SSIO_CONFIG` 优先于配置文件。

> `--platform` 的合法值是 `win | linux | android | any`（不是 Node 的 `win32`）；查询最新版本时不传 `--arch` 会按 `any` 匹配，客户端应传自身架构。

## 管理控制台

`console/` 是一个 React + Vite 应用，用 Master Key 登录，覆盖应用列表、版本（发布 / 下架 / 调灰度）、
卡密（生成 + 一次性导出）、公告、API Key（签发 / 吊销）。业务数据需要 API Key，
控制台会引导签发一个仅存于浏览器本地的会话 Key。

```bash
pnpm console:dev    # 本地启动控制台（localhost:5173，需先启动服务端）
```

---

## 部署

**Docker（推荐）**

```bash
cp .env.example .env     # 填 JWT_SECRET / MASTER_KEY
docker compose up -d     # 数据落在命名卷 ssio-data
```

另有裸机 systemd（`deploy/ssio.service`）与 Windows 服务（`deploy/install-windows.ps1`，基于 NSSM）两种方式；
反向代理、自动备份、升级与运维清单见 [`docs/04-部署运维.md`](docs/04-部署运维.md)。

**从本机一键部署到远程 Linux**

```bash
npm i ssh2    # 脚本按需加载，不进项目依赖
node deploy/remote-deploy.mjs --host <域名/IP> --user ubuntu --key ~/.ssh/id_ed25519
```

脚本会以 `git archive` 打包**已提交内容**（不含 `node_modules` / `dist` / `data`，未提交的改动不会上生产），
经 SFTP 上传后完成环境准备、依赖安装、构建、生成 `.env`、注册 systemd 与就绪自检，最后打印 Master Key。
支持 `--password`、`--dir`、`--port-ssio`、`--no-service`、`--dry-run`。

## 运维

```bash
pnpm backup --out /var/backups/ssio              # 在线备份，无需停服
pnpm restore --from <备份目录> --force            # 默认拒绝覆盖，需显式 --force
```

备份使用 SQLite 的 `VACUUM INTO` 产出**一致性快照**（直接复制数据库文件在 WAL 模式下可能拿到不一致的副本）；
恢复前会保留现有数据为 `.pre-restore-<时间戳>`，不会直接删除。

监控端点：`GET /v1/healthz`（存活）与 `GET /v1/readyz`（就绪，含数据库检查）。

---

## 配置

主要环境变量（完整清单见 [`.env.example`](.env.example)）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `JWT_SECRET` | —（**必填**） | 令牌签名密钥，至少 32 字符 |
| `MASTER_KEY` | —（**必填**） | 管理面主密钥，至少 16 字符 |
| `HOST` | `127.0.0.1` | 容器部署需设为 `0.0.0.0` |
| `PORT` | `8100` | 监听端口 |
| `DATA_DIR` | `./data` | 数据库与存储对象的位置，**唯一需要备份的目录** |
| `CORS_ORIGIN` | `*` | 浏览器直连时的跨域配置 |
| `RATE_LIMIT_MAX` | `600` | 单 IP 每窗口请求上限（窗口由 `RATE_LIMIT_WINDOW_MS` 控制，默认 60 000 ms） |
| `LOG_LEVEL` | `info` | 日志级别 |

---

## API 文档

[`docs/03-API参考.md`](docs/03-API参考.md) 由源码**自动生成**（`pnpm gen:api-docs`），
不会与实现脱节；`pnpm docs:check` 用于校验文档是否与当前路由一致，CI 会执行该检查。

---

## 性能

以下数据来自 `scripts/bench/bench-100mb.mjs`（服务端与客户端分离进程，Windows 11 / Node 22 / 内置 NVMe）：

| 场景 | 结果 |
|---|---|
| 100 MB 分片上传（25 × 4 MiB） | 端到端约 735 ms |
| 服务端进程内存增量 | RSS +37 MB（堆内仅 21 MB，文件内容不进 JS 堆） |
| 生成 10 000 张卡密并落库 | 约 430 ms |

内存不是瓶颈，主要成本是合并与 sha256 计算（单核算力，约 300 ms / 100 MB）。

---

## 安全设计

- **密钥不落库**：API Key 与卡密明文均只存储 sha256，明文仅在签发 / 导出响应中出现一次。
- **多租户隔离**：所有查询按应用过滤，跨应用一律 404（不泄露资源是否存在）。
- **签名下载 URL 有时效**：默认 300 秒，最长 3600 秒，过期即失效。
- **卡密导出是一次性的**：导出后密文立即销毁，无法二次获取。
- **启动即校验配置**：密钥强度不足直接拒绝启动，避免带默认密钥上线。
- 生产环境建议：前置反向代理启用 TLS，并在防火墙侧限制来源。

---

## 设计取舍

- **SQLite 单文件**：单机自托管场景足够，备份即复制文件；需要 PostgreSQL 时 Drizzle 层可整体替换。
- **SQL 优先**：使用 Drizzle 而非 Prisma，不引入运行时魔法，迁移可读、可回滚。
- **不用 bcrypt**：原生模块在部分平台编译困难，密码哈希采用 Node 内置 `scrypt`，参数编码进哈希串。
- **集成测试走真实 HTTP 栈**：Supertest + 每用例独立临时库，覆盖鉴权、限流与错误映射，不触碰开发库。
- **只做通用能力**：任何形如 `订单表`、`商品表` 的业务数据都不属于本项目。

---

## 仓库结构

```
packages/
  shared/    共享层：错误码、scope 常量、semver、API 类型（服务端与 SDK 共用）
  server/    服务端：Fastify 路由 + Drizzle(SQLite)，迁移在 drizzle/
  core/      @ssio/core   SDK 传输层（环境无关）
  web/       @ssio/web    浏览器 SDK（React hooks 在 @ssio/web/react）
  node/      @ssio/node   Node / Electron SDK（下载、校验、更新执行器）
  cli/       @ssio/cli    命令行工具
console/     管理控制台（React + Vite）
mobile/      Capacitor 移动端示例
examples/    浏览器最小接入、Electron 更新演示、全链路冒烟脚本
scripts/     性能基准、体积测量、API 文档生成
deploy/      systemd 单元、Windows 服务脚本、一键远程部署脚本
docs/        API 参考（自动生成）、部署运维、快速上手
```

## 开发

```bash
pnpm dev          # 开发运行
pnpm build        # 全包构建
pnpm test         # 全包测试
pnpm typecheck    # 全包类型检查
pnpm lint         # ESLint（--max-warnings 0）
pnpm db:generate  # 生成数据库迁移（请勿手写 CREATE TABLE）
pnpm example:e2e  # 全链路冒烟（需先 build）
```

CI 会执行类型检查、构建、测试、文档一致性校验与 lint。

## 文档

- [`docs/03-API参考.md`](docs/03-API参考.md) — 全部接口与所需 scope（自动生成）
- [`docs/04-部署运维.md`](docs/04-部署运维.md) — 部署方式、反向代理、备份恢复、运维清单
- [`docs/05-快速上手.md`](docs/05-快速上手.md) — 从零跑通发行、存储、发卡、公告
- [`packages/server/README.md`](packages/server/README.md) — 服务端实现细节与已记录的坑

## 许可证

[MIT](LICENSE)
