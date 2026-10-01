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

## 对外暴露的接口（P2）

**存储**

| 方法路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/storage/uploads` | `storage:write` | 初始化：声明 filename/size/chunkSize → 返回 uploadId |
| `PUT /v1/storage/uploads/:id/chunks/:index` | `storage:write` | 上传分片（裸流，默认 4 MB，允许 1–16 MB） |
| `POST /v1/storage/uploads/:id/complete` | `storage:write` | 合并 + 服务端算 sha256；与客户端声明值不符即报错 |
| `GET /v1/storage/files/:id` | `storage:read` | 文件元信息 |
| `GET /v1/storage/files/:id/download?ttl=300` | `storage:read` | 签名下载 URL（ttl 上限 3600） |
| `DELETE /v1/storage/files/:id` | `storage:write` | 软删；被 release 引用时拒绝（`?force=true` 强制） |
| `GET /v1/storage/quota` | `storage:read` | 已用字节 / 配额 |
| `GET /v1/storage/raw/*` | 仅 URL 签名 | 签名下载端点，支持 Range 续传 |

**发行 / 发卡 / 公告**

| 方法路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/releases` `GET /v1/releases` `GET /v1/releases/:id` | `release:write` / `release:read` | 版本 CRUD（唯一：app+渠道+平台+架构+版本） |
| `GET /v1/releases/latest` | `release:read` | 更新判定：灰度 + minVersion 强制 + platform/arch=any |
| `PATCH` `DELETE /v1/releases/:id` | `release:write` | 改灰度/发布状态；下架是软删 |
| `POST /v1/releases/:id/download` | `release:read` | 签名 URL + 下载计数自增 |
| `POST /v1/cards/batches` `GET /v1/cards/batches` | Master 或 `admin:*` | 生成卡密批次（普通业务 Key 无权） |
| `GET /v1/cards/batches/:id/export` | 一次性签名链接 | 明文 CSV，**导出即销毁**，不可二次获取 |
| `POST /v1/cards/redeem` | `cards:redeem` 或用户 JWT | 核销（幂等，并发只有一个首次成功） |
| `GET /v1/cards/:codeMask/status` | `cards:redeem` | 按掩码查状态 |
| `POST/GET/PATCH/DELETE /v1/announcements` | `announcements:write` / `read` | 公告 CRUD |
| `GET /v1/announcements/active` | `announcements:read` 或用户 JWT | 生效中的公告，置顶优先 |

## 存储驱动：怎么换成 S3

实现 `src/storage/driver.ts` 里的 `StorageDriver` 接口即可，路由层不用改：

```ts
export class S3Driver implements StorageDriver { /* put/get/getRange/delete/signUrl/stat */ }
// 注入：buildApp({ db, config, driver: new S3Driver(...) })
```

差别只在 `signUrl`：LocalDriver 返回「后端代理地址 + HMAC 自签参数」（由 `/v1/storage/raw/*` 校验），
S3Driver 应直接返回预签名 URL —— 那时 `raw` 端点可以整体下掉，签名校验交给对象存储。
`files.storageKey` 只是驱动内部的定位键，换驱动时旧 key 需要迁移。

## 实测数据（本机 Windows 11 / Node 22 / 内置 NVMe）

服务端跑在**独立进程**（客户端另起），数字可以归因到服务端：

| 场景 | 结果 |
|---|---|
| 100 MB 分片上传（25 × 4 MB） | 上传 433 ms + 合并校验 302 ms = **端到端 ~735 ms** |
| 服务端进程 RSS | 基线 ~95 MB → 峰值 ~131 MB，**增量 ~37 MB** |
| 服务端进程 `heapUsed` 峰值 | ~21 MB（流式合并，文件内容不进 JS 堆） |
| 服务端进程 `external` 峰值 | ~51 MB（分片读写缓冲，随 `chunkSize` 变化） |
| 生成 10000 张卡密并落库 | ~430 ms（远低于 5 s 上限） |

复跑：

```bash
pnpm build && node scripts/bench/bench-100mb.mjs      # 可用 BENCH_CHUNKS / BENCH_CHUNK_SIZE 调参
pnpm build && pnpm example:e2e                        # 全链路（examples/node-e2e.ts）
```

**轻量云 2C2G 能不能扛**：能。内存不是瓶颈（单路 100 MB 只增 ~37 MB，且 `heapUsed` 仅 21 MB）；
真正的瓶颈是 CPU —— 合并 + sha256 约 300 ms/100 MB 且是单核活，2 核大约并发 4 路就吃满。
并发上来后优先把 `chunkSize` 降到 1 MB（`external` 缓冲预期按比例下降，尚未实测），并把并发数限制在 4–8。

> 注意：vitest 里那个 100 MB 用例的 RSS 数字偏高（~287 MB），因为客户端与服务端同进程，
> 客户端自己持有的 100 MB 也算进去了。要看服务端自身开销请用上面的 bench 脚本。

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
- **Fastify 默认 `bodyLimit` 只有 1 MiB**：4 MB 分片上传会被 413 拦掉。分片路由必须单独设 `bodyLimit`（按路由放大，不要全局放宽）。另外二进制裸流要 `addContentTypeParser('application/octet-stream', { parseAs: 'buffer' })`。
- **响应 schema 会剔除未声明字段**：给 `schema.response` 之后，返回值里多出来的字段会被序列化器静默丢掉（调试时发现 `generatedInMs` 一直是 undefined）。想回传就得先写进 schema。
- **Node 的 type stripping 不做 `.js` → `.ts` 映射**：`node --experimental-strip-types` 跑 .ts 时，`import './x.js'` 不会去找 `x.ts`。所以 `examples/node-e2e.ts` 直接引编译产物 `dist/*.js`，运行前先 `pnpm build`。
- **Drizzle 的 `and(...conds)` 数组要显式标注类型**：`const conds = [eq(a, b)]` 会被推断成首元素类型，后面 `push` 其它列会报 `never`。写成 `const conds: SQL[] = [...]`。同理，`eq()` 右侧传 `string` 给字面量联合列会报错，查询参数的类型声明要用列的联合类型。
