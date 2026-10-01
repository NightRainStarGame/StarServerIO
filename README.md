# StarServerIO (SSIO)

自托管的**通用云后端中台（BaaS）**：一套服务，同时给多个应用提供账号、存储、发布、论坛、发卡、公告等通用能力。
本项目（StarServerIO）是**中台本体**；TaskManager 是它的第一个消费方。

## 当前进度

- ✅ **P1 服务端骨架**：pnpm monorepo、shared 共享层、Fastify 服务端、认证（APIKey / 用户 JWT / Master Key 三通道）、应用与 APIKey 管理、限流、审计日志。
- ⬜ P2–P9（发行/存储/发卡/公告、论坛与软件源、SDK、控制台与 CLI、打包部署、Capacitor、GitHub/CI、TaskManager 集成）

## 目录

```
packages/
  shared/   @ssio/shared  错误码、scope、semver、HTTP 契约类型（零运行时依赖）
  server/   @ssio/server  Fastify 5 + Drizzle(SQLite) 服务端
```

## 常用命令

```bash
pnpm install
pnpm dev            # 起服务端（默认 127.0.0.1:8100）
pnpm build          # 全量构建
pnpm test           # 全部单测 + 集成测试
pnpm typecheck      # 全量类型检查
pnpm lint           # eslint . --max-warnings 0
pnpm db:generate    # drizzle-kit 生成迁移（禁止手写 CREATE TABLE）
```

## 设计红线

1. **只做通用能力**。任何形如 `xxx_order` / `xxx_store` 的业务表都不属于 SSIO。
2. **多租户隔离**：所有数据按 app 隔离，跨应用查询一律 404。
3. **契约变更需报告**：`packages/shared/src/api.ts` 的字段改动会波及所有消费方。
4. **密钥不落库**：APIKey 只存 sha256，明文仅在签发响应里出现一次。

⚠️ 仓库位于 D 盘（USB 外接盘，有 Event 51 分页错误记录）。**每天收工前**请 `git push` 或同步一份到内置盘。
