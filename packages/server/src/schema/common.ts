import { Type, type TSchema } from '@sinclair/typebox';

/**
 * 可空字段的 schema 助手。
 *
 * ⚠️ 为什么必须把 `Null` 放在 union 的第一位？
 *
 * Ajv 的 `coerceTypes:'array'`（Fastify 默认值）**不会**关闭标量之间的强制转换，
 * 只限制「标量↔数组」。于是 `anyOf:[{number},{null}]` 遇到 `null` 时，会先命中 number 分支
 * 并把 null 强转成 **0**，校验通过、数据被静默改写。
 * 后果示例：APIKey 的 `expiresAt: null`（永不过期）会被存成 0，立刻被判定为已过期。
 *
 * 把 Null 放前面后，null 直接命中第一分支，不触发任何转换。
 * 实测（ajv 8.20）：
 *   null-first  : null→null, 0→null, 12345→12345
 *   number-first: null→0（错误）, 0→0, 12345→12345
 *
 * 所有「可空数值/字符串」字段一律用这里的助手，不要手写 `Type.Union([Type.Number(), Type.Null()])`。
 */

export function NullableNumber(): TSchema {
  return Type.Union([Type.Null(), Type.Number()]);
}

export function NullableInteger(): TSchema {
  return Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]);
}

export function NullableString(): TSchema {
  return Type.Union([Type.Null(), Type.String()]);
}

export function NullableBoolean(): TSchema {
  return Type.Union([Type.Null(), Type.Boolean()]);
}
