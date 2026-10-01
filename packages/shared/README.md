# @ssio/shared

SSIO 的跨端共享层。**不依赖任何运行时库**（无 DOM、无 fs），因此服务端、SDK、CLI 都能直接引。

## 装什么 / 对外暴露什么

| 模块 | 导出 | 用途 |
|---|---|---|
| `errors.ts` | `ERROR_DEFS`、`ERROR_CODES`、`AppError`、`isAppError` | 全站统一错误码与 `{ error: { code, message, details? } }` 响应结构 |
| `scopes.ts` | `SCOPES`、`hasScope`、`hasAllScopes`、`validateScopes` | APIKey 权限判定；只有 `admin:*` 是通配符 |
| `semver.ts` | `parse`、`compare`、`format`、`isValid`、`satisfiesRange` | 自研 semver（不引第三方），支持 `^` `~` `>=` `<` 与预发布比较 |
| `api.ts` | 全部 HTTP 契约类型 | 服务端与 SDK 共用的请求/响应类型，**字段变更即契约变更** |

## 怎么跑

```bash
pnpm --filter @ssio/shared test      # vitest 单测
pnpm --filter @ssio/shared build     # tsc 产出 dist（ESM + d.ts）
```

## 约定

- 新增错误码必须同步进 `docs/03-API参考.md`（由 `pnpm gen:api-docs` 生成，禁止手写）。
- 时间字段统一 Unix **毫秒**整数。
- 这里只允许出现通用概念（app / user / file / release / …）。出现任何业务方字样即为越界。
