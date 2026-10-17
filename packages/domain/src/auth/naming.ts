import type { BetterAuthPlugin } from 'better-auth'
import { getAuthTables } from 'better-auth/db'

// Better Auth 的模型名和字段名按规则映射成我们的表名和列名（ADR-0015）：模型名转成 snake_case 复数，
// 字段名转成 snake_case。映射从 Better Auth 自己的 schema 生成，不手写，升级时新增的字段自动跟上；
// 迁移是否与之一致，由 schema 比对测试（schema.db.test.ts）守护。

/** user.name 存在 nickname 列：BS 的叫法，也是 DTO 里的字段名（docs/schema.md） */
const COLUMN_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> = { user: { name: 'nickname' } }

type CoreModel = 'user' | 'session' | 'account' | 'verification'

function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

export function authTableName(model: string): string {
  const name = snakeCase(model)
  return name.endsWith('s') ? name : `${name}s`
}

export function authColumnName(model: string, field: string): string {
  return COLUMN_OVERRIDES[model]?.[field] ?? snakeCase(field)
}

type PluginSchema = NonNullable<BetterAuthPlugin['schema']>

/** 改写插件自带的 schema（与 Better Auth 的 mergeSchema 做的事相同），返回插件本身 */
export function withNamingConvention<P extends BetterAuthPlugin>(plugin: P): P {
  const schema: PluginSchema | undefined = plugin.schema
  for (const [model, table] of Object.entries(schema ?? {})) {
    table.modelName = authTableName(model)
    for (const [field, definition] of Object.entries(table.fields)) definition.fieldName = authColumnName(model, field)
  }
  return plugin
}

/** 核心四个模型的 modelName / fields 配置，直接展开进 betterAuth() 的选项 */
export function coreModelNaming() {
  const tables = getAuthTables({})
  const naming = (model: CoreModel) => ({
    modelName: authTableName(model),
    fields: Object.fromEntries(
      Object.keys(tables[model]!.fields).map((field) => [field, authColumnName(model, field)]),
    ),
  })
  return {
    user: naming('user'),
    session: naming('session'),
    account: naming('account'),
    verification: naming('verification'),
  }
}
