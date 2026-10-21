import {
  settingControl as pluginSettingControl,
  type JsonSchema,
  type SettingControl as PluginSettingControl,
} from '@nextskin/plugin-host'
import { z } from 'zod'
import { SITE_IMAGE_MAX_SIDE, SITE_IMAGE_MIN_SIDE } from '../site-images/image.ts'
import { coreSettingsRegistry, type CoreSettingKey } from './registry.ts'

// 映射控件的规则和插件设置共用，构建命令也要用，所以放在 plugin-host（ADR-0035）
export type { JsonSchema } from '@nextskin/plugin-host'

/** 核心设置项的控件：插件设置的那几种，加上站点图片（ADR-0042）。图片带上边长的范围，表单写进提示里 */
export type SettingControl = PluginSettingControl | { kind: 'image'; minSide: number; maxSide: number }

/**
 * 站点图片只认核心的设置项：值是存储里的 hash，可以为 null。插件的设置走 plugin-host 的规则，
 * 带同样的媒体类型照旧没有控件，插件 API 不变
 */
export function settingControl(schema: JsonSchema): SettingControl | null {
  if (
    schema.contentMediaType === 'image/png' &&
    schema.anyOf?.length === 2 &&
    schema.anyOf.some((branch) => branch.type === 'null') &&
    schema.anyOf.some((branch) => branch.type === 'string')
  )
    return { kind: 'image', minSide: SITE_IMAGE_MIN_SIDE, maxSide: SITE_IMAGE_MAX_SIDE }
  return pluginSettingControl(schema)
}

/** 注册表一项的输入 JSON Schema；机密项永远只写。 */
export function settingJsonSchema(key: CoreSettingKey): JsonSchema {
  const definition = coreSettingsRegistry[key]
  const schema = z.toJSONSchema(definition.schema, { io: 'input' })
  return definition.secret ? { ...schema, writeOnly: true } : schema
}
