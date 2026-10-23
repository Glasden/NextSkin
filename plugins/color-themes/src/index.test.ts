import { buildManifest, hasPluginMessage, pluginThemeIssues } from '@nextskin/plugin-host'
import { checkTheme, contrastRatio, diamond, oklabDistance, resolveTheme } from '@nextskin/theme'
import { expect, test } from 'vitest'
import plugin from './official.ts'

const manifest = buildManifest(plugin.definition, plugin.package)

test('更多配色只提供三套声明式主题，三套都通过完整检查', () => {
  expect(manifest.id).toBe('color-themes')
  expect(manifest.capabilities).toEqual([])
  expect(manifest.ui.themes?.map(({ name }) => name)).toEqual(['cobalt', 'magenta', 'high-contrast'])
  expect(pluginThemeIssues(manifest)).toEqual([])
  for (const theme of manifest.ui.themes ?? []) expect(checkTheme(resolveTheme(theme.colors))).toEqual([])
})

test('钴蓝只改强调色，淡底按附录推导，焦点框跟随强调色', () => {
  const cobalt = manifest.ui.themes![0]!
  expect(cobalt.colors).toEqual({ light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } })
  const resolved = resolveTheme(cobalt.colors)
  expect(resolved.light['accent-subtle']).toBe('#e5eafc')
  expect(resolved.dark['accent-subtle']).toBe('#282f41')
  for (const mode of ['light', 'dark'] as const) expect(resolved[mode].focus).toBe(resolved[mode].accent)
})

test('洋红的危险色和强调色、警告色都分得开，前景色和警告色保留默认', () => {
  const resolved = resolveTheme(manifest.ui.themes![1]!.colors)
  expect(resolved.light.warning).toBe(diamond.light.warning)
  expect(resolved.dark.warning).toBe(diamond.dark.warning)
  expect(resolved.light['danger-fg']).toBe('#ffffff')
  expect(resolved.dark['danger-fg']).toBe('#0e1013')
  for (const mode of ['light', 'dark'] as const) {
    const colors = resolved[mode]
    expect(oklabDistance(colors.accent, colors.danger)).toBeGreaterThanOrEqual(0.12)
    // 钻石青的危险色和警告色相距约 0.12，洋红不比它更难分
    expect(oklabDistance(colors.danger, colors.warning)).toBeGreaterThanOrEqual(0.125)
    for (const name of ['danger', 'warning'] as const) {
      expect(contrastRatio(colors[`${name}-fg`], colors[name])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(colors[name], colors.surface)).toBeGreaterThanOrEqual(4.5)
    }
  }
})

test('高对比的结构原样保留，亮色色块独立于强调色，暗色色块跟随强调色', () => {
  const highContrast = manifest.ui.themes![2]!
  expect(highContrast.structure).toEqual({ radius: 'square', borders: 'thick', cards: 'raised' })
  expect(highContrast.colors.dark).not.toHaveProperty('accent-fill')
  expect(highContrast.colors.dark).not.toHaveProperty('accent-fill-fg')
  const resolved = resolveTheme(highContrast.colors)
  expect(resolved.light.accent).toBe('#000000')
  expect(resolved.light['accent-fill']).toBe('#d4ff1e')
  expect(resolved.light['accent-fill']).not.toBe(resolved.light.accent)
  expect(resolved.dark['accent-fill']).toBe(resolved.dark.accent)
  expect(resolved.dark['accent-fill-fg']).toBe(resolved.dark['accent-fg'])
})

test('插件名字、简介和主题名字在两种语言里都有文案', () => {
  for (const locale of ['zh-CN', 'en'] as const)
    for (const key of ['plugin.name', 'plugin.description', ...manifest.ui.themes!.map(({ label }) => label)])
      expect(hasPluginMessage({ [locale]: plugin.messages[locale] }, key)).toBe(true)
})
