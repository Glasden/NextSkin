import type { PluginSettingView } from '@nextskin/domain'
import type { SettingText } from '../app/admin/settings/setting-text'

/** 插件设置项的文案按约定取（SDK 的 ui.ts）：`settings.<键>.label`，对象的属性、枚举的选项各有一层 */
export function pluginSettingText(translate: (key: string) => string, view: PluginSettingView): SettingText {
  const optional = (key: string) => {
    const text = translate(key)
    return text === key ? undefined : text
  }
  const prefix = `settings.${view.key}`
  const label = optional(`${prefix}.label`) ?? view.key
  const control = view.control
  return {
    label,
    help: optional(`${prefix}.help`),
    options:
      control.kind === 'select'
        ? Object.fromEntries(
            control.options.map((option) => [option, optional(`${prefix}.options.${option}`) ?? option]),
          )
        : undefined,
    fields:
      control.kind === 'object'
        ? Object.fromEntries(
            control.properties.map(({ name, control: child }) => [
              name,
              {
                label: optional(`${prefix}.fields.${name}.label`) ?? name,
                help: optional(`${prefix}.fields.${name}.help`),
                options:
                  child.kind === 'select'
                    ? Object.fromEntries(
                        child.options.map((option) => [
                          option,
                          optional(`${prefix}.fields.${name}.options.${option}`) ?? option,
                        ]),
                      )
                    : undefined,
              },
            ]),
          )
        : undefined,
  }
}
