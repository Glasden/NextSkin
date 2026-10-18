import { getMessages, locales } from '@nextskin/i18n'
import { expect, test } from 'vitest'
import { settingControl, settingJsonSchema, type SettingControl } from './form.ts'
import { coreSettingsRegistry, settingSections, type CoreSettingKey } from './registry.ts'

// 设置页的文案按键名嵌套在 admin.settings.fields 下（ADR-0028）：漏写了，页面上就会显示键名
const visible = (Object.keys(coreSettingsRegistry) as CoreSettingKey[]).filter(
  (key) => coreSettingsRegistry[key].section !== null,
)

function lookup(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    root,
  )
}

function expectLabels(locale: string, entry: unknown, control: SettingControl, where: string) {
  expect(lookup(entry, ['label']), `${locale} ${where}.label`).toEqual(expect.any(String))
  if (control.kind === 'select')
    for (const option of control.options)
      expect(lookup(entry, ['options', option]), `${locale} ${where}.options.${option}`).toEqual(expect.any(String))
  if (control.kind === 'object')
    for (const property of control.properties)
      expectLabels(
        locale,
        lookup(entry, ['fields', property.name]),
        property.control,
        `${where}.fields.${property.name}`,
      )
}

test('每个可见的设置项在两种语言里都有标签，枚举的选项和对象的属性也都有文案', () => {
  for (const locale of locales) {
    const fields = getMessages(locale).admin.settings.fields
    for (const key of visible) {
      const control = settingControl(settingJsonSchema(key))!
      expectLabels(locale, lookup(fields, key.split('.')), control, key)
    }
    for (const section of settingSections)
      expect(getMessages(locale).admin.settings.sections[section], `${locale} 分区 ${section}`).toEqual(
        expect.any(String),
      )
  }
})

test('有 generate 的设置项写明生成的后果', () => {
  for (const locale of locales)
    for (const key of visible.filter((key) => 'generate' in coreSettingsRegistry[key]))
      expect(lookup(getMessages(locale).admin.settings.fields, [...key.split('.'), 'generateHint'])).toEqual(
        expect.any(String),
      )
})
