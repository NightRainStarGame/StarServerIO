# @ssio/server

SSIO 服务端：Fastify 5 + Drizzle ORM(SQLite) 的多租户通用后端。

## 装什么

| 依赖 | 为什么是它 |
|---|---|
| `fastify` 5 | 路由 + schema 校验 + 序列化 |
| `drizzle-orm` + `drizzle-kit` | SQL 优先、无运行时魔法；迁移可回滚 |
| `better-sqlite3` | 同步 API，单机单文件，备份就是拷文件 |
| `zod` | 环境变量校验 |
| `jose` | JWT（纯 JS，无原生编译） |
| `@fastify/rate-limit` | 限流 |
| `@fastify/cors` | 浏览器端 SDK 需要 |

**不用 bcrypt**：原生模块在 Windows 上编译易炸；密码哈希改用 Node 内置 `scrypt`（抗 ASIC，参数编码进哈希串）。

## 怎么跑

```bash
cp .env.example .env        # 填 JWT_SECRET(≥32) 与 MASTER_KEY(≥16)
pnpm dev                    # tsc + node dist/index.js
# 或
pnpm build && pnpm start
```

- 缺 `JWT_SECRET` / `MASTER_KEY` 或长度不足 → **拒绝启动**，不提供默认值。
- 启动后：`http://127.0.0.1:8100/v1/healthz`、`/v1/readyz`（readyz 会真查一次库）。

## 对外暴露的接口（P1）

| 方法路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /v1/healthz` `GET /v1/readyz` | 无 | 健康检查 |
| `POST /v1/apps` `GET /v1/apps` `GET/PATCH/DELETE /v1/apps/:id` | Master Key | 应用（租户）CRUD |
| `POST /v1/keys` `GET /v1/keys` `DELETE /v1/keys/:id` | Master Key | APIKey 签发/列表/吊销 |
| `POST /v1/auth/register` `/login` `/refresh` | APIKey（不需 admin） | 用户认证 |
| `POST /v1/auth/logout` `GET /v1/auth/me` | 用户 JWT | 当前用户 |
| `POST /v1/auth/introspect` | APIKey + `auth:read` | 业务后端校验用户 JWT |
| `GET /v1/users/:id` | APIKey + `users:read` | 用户资料（不含手机/邮箱） |

Master Key 用 `X-Master-Key` 头，APIKey 用 `X-API-Key` 头，用户用 `Authorization: Bearer <access>`。

## 怎么测

```bash
pnpm --filter @ssio/server test
```

集成测试用 Supertest 打**真实 HTTP 栈**（含鉴权/限流/错误映射），每个用例一个 `os.tmpdir()` 临时库，跑完删除；**不碰开发库**。

## Windows 环境坑：better-sqlite3

本机 Node 22（ABI 127）。pnpm 会去 GitHub 拉预编译包，本机 GitHub 不可达时构建脚本会失败。已确认可用的做法：

```powershell
# 从 npmmirror 二进制镜像取 Node 22 的预编译产物
curl.exe -sSL -o bs3.tar.gz "https://registry.npmmirror.com/-/binary/better-sqlite3/v11.10.0/better-sqlite3-v11.10.0-node-v127-win32-x64.tar.gz"
tar.exe -xzf bs3.tar.gz -C bs3x
Copy-Item "bs3x\build\Release\better_sqlite3.node" `
  "node_modules\.pnpm\better-sqlite3@11.10.0\node_modules\better-sqlite3\build\Release\" -Force
```

根 `package.json` 里的 `pnpm.onlyBuiltDependencies` **故意不含** `better-sqlite3`：让它不再尝试编译，直接用上面放好的二进制。

## 已记录的坑

- **Ajv 会把 `null` 静默强转成 `0`**：`coerceTypes:'array'`（Fastify 默认）只限制「标量↔数组」，标量互转仍然开启。所以 `anyOf:[{number},{null}]` 遇到 `null` 会存成 `0`，导致「永不过期」的 APIKey 被判定为已过期。所有可空字段必须用 `src/schema/common.ts` 的 `Nullable*()`（Null 分支前置）。
- **`decorateRequest` 不接受引用类型**：只能传 `null`/原始值，每个请求的对象在 `onRequest` 钩子里新建。
- **Supertest 必须配已 listen 的 server**：否则它会在每次请求后把自己起的服务关掉，后续请求 ECONNREFUSED。
- **请求体非法 JSON 要显式映射 400**：Fastify 抛 `FST_ERR_CTP_INVALID_JSON_BODY`，不处理会变成 500。
