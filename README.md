# StarServerIO (SSIO)

自托管的通用云后端中台（BaaS）。一套服务，多个应用共用：账号、文件存储、版本发行、卡密、公告、论坛、软件源。

本项目（StarServerIO）是**中台本体**；TaskManager 是它的第一个消费方。

单体仓库（pnpm workspace），Node 22 + TypeScript，服务端 Fastify 5 + Drizzle ORM(SQLite)。

> 当前阶段：**P1 服务端骨架已完成**，P2 及以后未开工。接口清单见 [`packages/server/README.md`](packages/server/README.md)。

## 30 秒跑起来

```bash
corepack enable            # 或 npm i -g pnpm
pnpm install
cp packages/server/.env.example packages/server/.env
# 编辑 .env：JWT_SECRET 至少 32 字符，MASTER_KEY 至少 16 字符（缺失或不达标会拒绝启动）
pnpm dev                   # http://127.0.0.1:8100
```

验证：

```bash
curl http://127.0.0.1:8100/v1/healthz    # {"status":"ok",...}
curl http://127.0.0.1:8100/v1/readyz     # 会真查一次数据库
```

## 仓库结构

```
packages/
  shared/   共享层：错误码、scope 常量、semver 比较、API 类型（server 与 SDK 共用）
  server/   服务端：Fastify 路由 + Drizzle(SQLite)，迁移在 drizzle/
```

以后会依次加入 `sdk/`、`console/`、`cli/` 等包。

## 鉴权模型（三通道）

| 通道 | 头部 | 用途 |
|---|---|---|
| Master Key | `X-Master-Key` | 平台管理员：建应用、签发/吊销 APIKey |
| API Key | `X-API-Key` | 应用服务端：带 scope 调用业务接口 |
| 用户 JWT | `Authorization: Bearer <access>` | 终端用户：访问自己的资源 |

用户 JWT 由 APIKey 通道签发（注册/登录），刷新令牌采用**轮换制**：每次 refresh 都换新并作废旧令牌。
业务后端拿不准用户 JWT 是否有效时，用 `POST /v1/auth/introspect` 问一次（需 `auth:read` scope）。

## 设计取向

- **SQLite 单文件**：单机自托管场景够用，备份就是拷文件。需要换 Postgres 时 Drizzle 层可整体替换。
- **SQL 优先**：用 Drizzle 而不是 Prisma，不引入运行时魔法，迁移可读可回滚。
- **不用 bcrypt**：原生模块在 Windows 上编译易炸，密码哈希用 Node 内置 `scrypt`，参数编码进哈希串。
- **集成测试打真实 HTTP 栈**：Supertest + 每个用例一个临时库，覆盖鉴权/限流/错误映射，不碰开发库。

## 常用命令

```bash
pnpm dev          # 开发（tsc 后直接跑 dist）
pnpm build        # 全包构建
pnpm test         # 全包测试
pnpm typecheck    # 全包类型检查（最便宜的验证）
pnpm lint         # ESLint，--max-warnings 0
pnpm db:generate  # drizzle-kit 生成迁移（禁止手写 CREATE TABLE）
```

## 设计红线

1. **只做通用能力**。任何形如 `xxx_order` / `xxx_store` 的业务表都不属于 SSIO。
2. **多租户隔离**：所有数据按 app 隔离，跨应用查询一律 404。
3. **契约变更需报告**：`packages/shared/src/api.ts` 的字段改动会波及所有消费方。
4. **密钥不落库**：APIKey 只存 sha256，明文仅在签发响应里出现一次。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 | 服务端骨架：monorepo、认证、应用与 APIKey 管理 | 完成 |
| P2 | 核心能力：版本发行、分片存储、发卡、公告 | 待开工 |
| P3 | 论坛与软件源 | 待开工 |
| P4 | 客户端 SDK | 待开工 |
| P5 | 控制台与 CLI | 待开工 |
| P6 | 打包与部署（Docker / 备份恢复 / API 文档生成） | 待开工 |
| P7 | Capacitor 移动端壳 | 待开工 |
| P8 | GitHub 仓库与 CI | 进行中 |
| P9 | TaskManager 集成（首个消费方） | 待开工 |

## 环境变量

见 [`packages/server/.env.example`](packages/server/.env.example)。缺少必需变量或长度不达标时服务**拒绝启动**，不提供不安全的默认值。

## 环境提醒

- 仓库位于 D 盘（USB 外接盘，有 Event 51 分页错误记录）。**每天收工前**请 `git push`，或同步一份到内置盘。
- 若 `git push` 报 `Failed to connect to github.com:443`：多半是本机 hosts 被第三方加速工具劫持（把 `*.github.com` 指到 127.0.0.1），而配套的本地反代没在运行。此时改走 SSH 通道即可：

  ```bash
  git -c url."git@ssh.github.com:".insteadOf="https://github.com/" push origin main
  ```
