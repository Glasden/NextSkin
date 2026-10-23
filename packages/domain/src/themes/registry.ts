import {
  checkTheme,
  DIAMOND,
  diamondStructure,
  pluginThemeId,
  resolveStructure,
  resolveTheme,
  themeCss,
  type ResolvedStructure,
  type ResolvedTheme,
  type ThemeIssue,
} from '@nextskin/theme'
import type { PluginSystem } from '../plugins/system.ts'

export interface ThemeEntry {
  id: string
  /** 内置主题为 null */
  pluginId: string | null
  /** 插件的文案键；内置主题为它的 id */
  label: string
  /** 限定在 data-theme 上的 CSS，小样用；钻石青也有 */
  css: string
}
export interface InvalidTheme {
  id: string
  pluginId: string
  label: string
  issues: ThemeIssue[]
}

export function createThemeRegistry(plugins: Pick<PluginSystem, 'activeUi'>) {
  const resolved = resolveTheme()
  const diamond = {
    entry: { id: DIAMOND, pluginId: null, label: DIAMOND, css: themeCss(DIAMOND, resolved, diamondStructure) },
    resolved,
    structure: diamondStructure,
  }
  type Ui = ReturnType<PluginSystem['activeUi']>[number]['ui']
  const cache = new WeakMap<
    Ui,
    { themes: (ThemeEntry & { resolved: ResolvedTheme; structure: ResolvedStructure })[]; invalid: InvalidTheme[] }
  >()
  return () => {
    const themes: ThemeEntry[] = [{ ...diamond.entry }]
    const invalid: InvalidTheme[] = []
    for (const { id: pluginId, ui } of plugins.activeUi()) {
      let entries = cache.get(ui)
      if (!entries) {
        entries = { themes: [], invalid: [] }
        for (const theme of ui.themes ?? []) {
          const id = pluginThemeId(pluginId, theme.name)
          const resolved = resolveTheme(theme.colors)
          const structure = resolveStructure(theme.structure)
          const issues = checkTheme(resolved)
          if (issues.length) entries.invalid.push({ id, pluginId, label: theme.label, issues })
          else
            entries.themes.push({
              id,
              pluginId,
              label: theme.label,
              css: themeCss(id, resolved, structure),
              resolved,
              structure,
            })
        }
        cache.set(ui, entries)
      }
      // 完整取值留在缓存里，查询只暴露页面需要的字段。
      themes.push(...entries.themes.map(({ id, pluginId, label, css }) => ({ id, pluginId, label, css })))
      invalid.push(...entries.invalid)
    }
    return { themes, invalid }
  }
}
