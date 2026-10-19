import type { JsonSchema } from '@nextskin/plugin-host'
import { z } from 'zod'
import { coreSettingsRegistry, type CoreSettingKey } from './registry.ts'

// 映射控件的规则和插件设置共用，构建命令也要用，所以放在 plugin-host（ADR-0035）
export { settingControl, type JsonSchema, type SettingControl } from '@nextskin/plugin-host'

/** 注册表一项的输入 JSON Schema；机密项永远只写。 */
export function settingJsonSchema(key: CoreSettingKey): JsonSchema {
  const definition = coreSettingsRegistry[key]
  const schema = z.toJSONSchema(definition.schema, { io: 'input' })
  return definition.secret ? { ...schema, writeOnly: true } : schema
}
