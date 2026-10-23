import { describe, expect, it, test } from 'vitest'
import {
  checkTheme,
  contrastRatio,
  describeThemeIssue,
  diamond,
  DIAMOND,
  diamondStructure,
  isHexColor,
  isThemeId,
  lockedColorNames,
  mix,
  normalizeThemeColors,
  oklabDistance,
  pluginThemeId,
  pluginThemesError,
  resolveStructure,
  resolveTheme,
  structureVariables,
  themeColorNames,
  themeColorsError,
  themeCss,
  themeStructureError,
} from './index.ts'

// DESIGN.md 附录里的两套备选主题：只给了强调色，focus 和 accent-subtle 按推导补
const cobalt = { light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } }
const magenta = { light: { accent: '#c2186b' }, dark: { accent: '#ff7ab8' } }
// ADR-0058 的高对比：亮色下荧光色只当色块，表面上的强调色用黑色
const highContrast = {
  light: {
    bg: '#ffffff',
    surface: '#ffffff',
    'surface-raised': '#ffffff',
    'surface-sunken': '#f0f0f0',
    border: '#bdbdbd',
    'border-strong': '#000000',
    text: '#000000',
    'text-muted': '#4a4a4a',
    'text-inverse': '#ffffff',
    accent: '#000000',
    'accent-fg': '#ffffff',
    'accent-subtle': '#f0ffb0',
    'accent-fill': '#d4ff1e',
    'accent-fill-fg': '#000000',
    success: '#00813a',
    'success-fg': '#ffffff',
    warning: '#a85600',
    'warning-fg': '#ffffff',
    danger: '#d0021b',
    'danger-fg': '#ffffff',
    focus: '#0040ff',
    shadow: '#000000',
  },
  dark: {
    bg: '#000000',
    surface: '#0b0b0b',
    'surface-raised': '#161616',
    'surface-sunken': '#050505',
    border: '#3d3d3d',
    'border-strong': '#ffffff',
    text: '#ffffff',
    'text-muted': '#b5b5b5',
    'text-inverse': '#000000',
    accent: '#d4ff1e',
    'accent-fg': '#000000',
    'accent-subtle': '#37410f',
    success: '#3ddc84',
    'success-fg': '#000000',
    warning: '#ffb020',
    'warning-fg': '#000000',
    danger: '#ff4d5e',
    'danger-fg': '#000000',
    focus: '#d4ff1e',
    shadow: '#e6e6e6',
  },
} as const

describe('contrastRatio', () => {
  it('黑白是 21，同色是 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
    expect(contrastRatio('#123456', '#123456')).toBe(1)
    expect(contrastRatio('#ff0000', '#ffffff')).toBeCloseTo(3.99847677)
  })

  it('对调前景背景结果相同，接受大写十六进制', () => {
    expect(contrastRatio('#123456', '#ABCDEF')).toBe(contrastRatio('#ABCDEF', '#123456'))
    expect(contrastRatio('#abcdef', '#123456')).toBe(contrastRatio('#ABCDEF', '#123456'))
  })

  it.each(['', '#fff', '#12345678', '123456', '#gg0000', 'rgb(0, 0, 0)', ' #123456', '#123456\n'])(
    '非法输入 %j 抛错',
    (value) => {
      expect(isHexColor(value)).toBe(false)
      expect(() => contrastRatio(value, '#ffffff')).toThrow()
      expect(() => contrastRatio('#ffffff', value)).toThrow()
    },
  )
})

test('混色按通道四舍五入，结果小写', () => {
  expect(mix('#08736B', '#FFFFFF', 0.12)).toBe('#e1eeed')
  expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  expect(mix('#123456', '#abcdef', 1)).toBe('#123456')
  expect(mix('#123456', '#abcdef', 0)).toBe('#abcdef')
})

test('OKLab 距离：同色是 0，黑白是 1，对调结果相同', () => {
  expect(oklabDistance('#123456', '#123456')).toBe(0)
  expect(oklabDistance('#000000', '#ffffff')).toBeCloseTo(1, 4)
  expect(oklabDistance('#08736b', '#c32b2b')).toBe(oklabDistance('#c32b2b', '#08736b'))
})

describe('钻石青', () => {
  it('颜色正好是主题能改的加上锁住的，没有重名', () => {
    const names = [...themeColorNames, ...lockedColorNames]
    expect(new Set(names).size).toBe(names.length)
    expect(Object.keys(diamond.light).sort()).toEqual([...names].sort())
    expect(Object.keys(diamond.dark).sort()).toEqual([...names].sort())
  })

  it('什么都不写时补齐出来的就是钻石青：focus 和 accent-subtle 正好是推导的值', () => {
    expect(resolveTheme()).toEqual(diamond)
    expect(resolveTheme({ light: {}, dark: {} })).toEqual(diamond)
  })

  it('通过检查；强调色和危险色的距离与 ADR 写的一致', () => {
    expect(checkTheme(diamond)).toEqual([])
    expect(oklabDistance(diamond.light.accent, diamond.light.danger)).toBeCloseTo(0.27, 2)
    expect(oklabDistance(diamond.dark.accent, diamond.dark.danger)).toBeCloseTo(0.32, 2)
  })
})

describe('推导', () => {
  it('只改强调色时焦点框和淡底跟着换，得到附录里的值', () => {
    const theme = resolveTheme(cobalt)
    expect(theme.light).toMatchObject({ accent: '#2a52e5', focus: '#2a52e5', 'accent-subtle': '#e5eafc' })
    expect(theme.dark).toMatchObject({ accent: '#86a2ff', focus: '#86a2ff', 'accent-subtle': '#282f41' })
    expect(resolveTheme(magenta).light['accent-subtle']).toBe('#f8e3ed')
    expect(resolveTheme(magenta).dark['accent-subtle']).toBe('#3b2936')
    expect(theme.light.text).toBe(diamond.light.text)
  })

  it('没写色块时跟着 accent 和 accent-fg，写了的不推导', () => {
    const theme = resolveTheme(cobalt)
    expect(theme.light).toMatchObject({ 'accent-fill': '#2a52e5', 'accent-fill-fg': diamond.light['accent-fg'] })
    expect(resolveTheme({ light: { 'accent-fg': '#000000' } }).light['accent-fill-fg']).toBe('#000000')
    const fill = resolveTheme({ light: { accent: '#000000', 'accent-fill': '#D4FF1E', 'accent-fill-fg': '#000000' } })
    expect(fill.light).toMatchObject({ accent: '#000000', 'accent-fill': '#d4ff1e', 'accent-fill-fg': '#000000' })
  })

  it('写了的 token 不推导；淡底按这个主题的 surface 混', () => {
    const theme = resolveTheme({
      light: { accent: '#2a52e5', focus: '#000000', 'accent-subtle': '#FAFAFA', surface: '#f0f0f0' },
    })
    expect(theme.light.focus).toBe('#000000')
    expect(theme.light['accent-subtle']).toBe('#fafafa')
    expect(resolveTheme({ light: { accent: '#2a52e5', surface: '#f0f0f0' } }).light['accent-subtle']).toBe(
      mix('#2a52e5', '#f0f0f0', 0.12),
    )
    // 暗色没写，整套是钻石青
    expect(theme.dark).toEqual(diamond.dark)
  })

  it('锁住的颜色和不认识的键忽略', () => {
    const theme = resolveTheme({ light: { stage: '#000000', nope: '#000000' } as never })
    expect(theme.light.stage).toBe(diamond.light.stage)
    expect(theme.light).not.toHaveProperty('nope')
  })
})

describe('检查', () => {
  it('钴蓝通过；洋红配默认的危险色太近', () => {
    expect(checkTheme(resolveTheme(cobalt))).toEqual([])
    const issues = checkTheme(resolveTheme(magenta))
    expect(issues.map(({ mode, check, pair }) => ({ mode, check, pair }))).toEqual([
      { mode: 'light', check: 'distance', pair: ['accent', 'danger'] },
      { mode: 'dark', check: 'distance', pair: ['accent', 'danger'] },
    ])
  })

  it('高对比通过：荧光色只当色块，不查它和表面的对比度', () => {
    expect(checkTheme(resolveTheme(highContrast)).map(describeThemeIssue)).toEqual([])
    const asIs = resolveTheme({
      ...highContrast,
      light: { ...highContrast.light, accent: '#d4ff1e', 'accent-fg': '#000000' },
    })
    expect(checkTheme(asIs).map(({ mode, pair }) => ({ mode, pair }))).toEqual([
      { mode: 'light', pair: ['accent', 'bg'] },
      { mode: 'light', pair: ['accent', 'surface'] },
    ])
  })

  it('色块单独查上面的字和危险色的距离；和 accent 那组的值相同时不重复报', () => {
    const issues = checkTheme(resolveTheme({ light: { 'accent-fill': '#c32b2b', 'accent-fill-fg': '#c32b2b' } }))
    expect(issues.map(({ check, pair }) => ({ check, pair }))).toEqual([
      { check: 'contrast', pair: ['accent-fill-fg', 'accent-fill'] },
      { check: 'distance', pair: ['accent-fill', 'danger'] },
    ])
    const same = checkTheme(resolveTheme({ light: { 'accent-fg': '#08736b' } }))
    expect(same.map(({ pair }) => pair)).toEqual([['accent-fg', 'accent']])
  })

  it('对比度不够时报出哪一组、实际值和最低值', () => {
    const issues = checkTheme(resolveTheme({ light: { 'text-muted': '#9ba2ad' } }))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]).toMatchObject({ mode: 'light', check: 'contrast', pair: ['text-muted', 'bg'], minimum: 4.5 })
    expect(issues[0]).toHaveProperty('values', ['#9ba2ad', '#f2f3f5'])
    expect(describeThemeIssue(issues[0]!)).toContain('text-muted 和 bg 的对比度')
  })

  it('把暗色的底塞进亮色：明暗方向不对', () => {
    const issues = checkTheme(resolveTheme({ light: diamond.dark }))
    expect(issues.filter((issue) => issue.check === 'lightness')).toEqual([
      { mode: 'light', check: 'lightness', pair: ['bg', 'text'], values: [diamond.dark.bg, diamond.dark.text] },
      {
        mode: 'light',
        check: 'lightness',
        pair: ['text-inverse', 'text'],
        values: [diamond.dark['text-inverse'], diamond.dark.text],
      },
    ])
  })
})

describe('形状', () => {
  it('合法的颜色', () => {
    expect(themeColorsError({})).toBeNull()
    expect(themeColorsError({ light: { accent: '#ABCDEF' } })).toBeNull()
    expect(themeColorsError({ light: {}, dark: { focus: '#000000' } })).toBeNull()
  })

  it.each([
    [null, 'colors 必须是对象'],
    [[], 'colors 必须是对象'],
    [{ auto: {} }, 'colors 里没有 auto 这一项'],
    [{ light: [] }, 'colors.light 必须是对象'],
    [{ light: { stage: '#000000' } }, 'stage 不是主题能改的颜色'],
    [{ dark: { accnet: '#000000' } }, 'accnet 不是主题能改的颜色'],
    [{ light: { accent: '#fff' } }, 'colors.light.accent 必须是 #rrggbb'],
    [{ light: { accent: 'red' } }, 'colors.light.accent 必须是 #rrggbb'],
    [{ light: { accent: '#000000;}body{x:y' } }, 'colors.light.accent 必须是 #rrggbb'],
  ])('不合法的颜色 %j', (value, message) => {
    expect(themeColorsError(value)).toContain(message)
  })

  it('插件的主题列表', () => {
    const theme = (name: string) => ({ name, label: `themes.${name}`, colors: {} })
    expect(pluginThemesError([])).toBeNull()
    expect(pluginThemesError([theme('cobalt'), theme('deep-sea2')])).toBeNull()
    expect(pluginThemesError(Array.from({ length: 16 }, (_, i) => theme(`t${i}`)))).toBeNull()
    expect(pluginThemesError({})).toContain('数组')
    expect(pluginThemesError(Array.from({ length: 17 }, (_, i) => theme(`t${i}`)))).toContain('16')
    expect(pluginThemesError([theme('cobalt'), theme('cobalt')])).toContain('重复')
    for (const name of ['', 'Cobalt', '1st', 'a--b', 'a-', 'a/b', 'x'.repeat(33)])
      expect(pluginThemesError([theme(name)]), name).toContain('name')
    expect(pluginThemesError([{ name: 'a', label: 1, colors: {} }])).toContain('label')
    expect(pluginThemesError([{ name: 'a', label: 'x', colors: {}, css: '' }])).toContain('css')
    expect(pluginThemesError([{ name: 'a', label: 'x' }])).toContain('colors 必须是对象')
    expect(pluginThemesError([{ ...theme('a'), structure: { radius: 'square' } }])).toBeNull()
    expect(pluginThemesError([{ ...theme('a'), structure: { radius: 'round' } }])).toContain(
      '主题 a 的 structure.radius 只能是 rounded、square',
    )
  })

  it('结构', () => {
    expect(themeStructureError({})).toBeNull()
    expect(themeStructureError({ radius: 'square', borders: 'thick', cards: 'raised' })).toBeNull()
    expect(themeStructureError(null)).toBe('structure 必须是对象')
    expect(themeStructureError([])).toBe('structure 必须是对象')
    expect(themeStructureError({ shadow: 'none' })).toBe('structure 里没有 shadow 这一项')
    expect(themeStructureError({ borders: 2 })).toBe('structure.borders 只能是 thin、thick：2')
    expect(themeStructureError({ cards: '4px 4px 0 0 red' })).toContain('structure.cards 只能是 flat、raised')
  })

  it('色值转小写，省略的模式不补', () => {
    expect(normalizeThemeColors({ light: { accent: '#ABCDEF' } })).toEqual({ light: { accent: '#abcdef' } })
    expect(normalizeThemeColors({})).toEqual({})
  })
})

describe('结构', () => {
  it('没写的和不认识的取钻石青', () => {
    expect(resolveStructure()).toEqual(diamondStructure)
    expect(resolveStructure({ radius: 'square' })).toEqual({ ...diamondStructure, radius: 'square' })
    expect(resolveStructure({ radius: 'round', borders: 'thick' } as never)).toEqual({
      ...diamondStructure,
      borders: 'thick',
    })
  })

  it('每项只改自己的变量，选中框是常规边框的两倍', () => {
    expect(structureVariables(diamondStructure)).toEqual({
      'radius-sm': '2px',
      'radius-md': '4px',
      'border-width-base': '1px',
      'outline-width-selected': '2px',
      'card-shadow': '0 0 #0000',
    })
    expect(structureVariables({ radius: 'square', borders: 'thick', cards: 'raised' })).toEqual({
      'radius-sm': '0',
      'radius-md': '0',
      'border-width-base': '2px',
      'outline-width-selected': '4px',
      'card-shadow': '4px 4px 0 0 var(--color-shadow)',
    })
  })
})

describe('CSS', () => {
  it('两种模式下的全部颜色，锁住的取钻石青', () => {
    const css = themeCss(pluginThemeId('color-themes', 'cobalt'), resolveTheme(cobalt), diamondStructure)
    expect(css.startsWith("[data-theme='color-themes/cobalt']{--color-bg:#f2f3f5;")).toBe(true)
    expect(css).toContain("}[data-theme='color-themes/cobalt'][data-mode='dark']{--color-bg:#0e1013;")
    expect(css.match(/--color-/g)).toHaveLength((themeColorNames.length + lockedColorNames.length) * 2)
    expect(css).toContain('--color-accent:#2a52e5;')
    expect(css).toContain('--color-focus:#86a2ff;')
    expect(css).toContain(`--color-stage:${diamond.light.stage};`)
    expect(css).toContain(`--color-stage:${diamond.dark.stage};`)
    expect(css.length).toBeLessThan(1800)
  })

  it('结构只写在不分亮暗的那一块里，钻石青的也写', () => {
    const structured = themeCss('a/b', diamond, { radius: 'square', borders: 'thick', cards: 'raised' })
    const [light, dark] = structured.split("}[data-theme='a/b'][data-mode='dark']{")
    expect(light).toContain('--radius-sm:0;--radius-md:0;--border-width-base:2px;--outline-width-selected:4px;')
    expect(light).toContain('--card-shadow:4px 4px 0 0 var(--color-shadow);')
    expect(dark).not.toContain('--radius')
    expect(themeCss(DIAMOND, diamond, diamondStructure)).toContain('--radius-sm:2px;')
  })

  it('id 只能是内置主题或 <插件 id>/<名字>', () => {
    expect(isThemeId(DIAMOND)).toBe(true)
    expect(isThemeId('color-themes/cobalt')).toBe(true)
    for (const id of ['', 'a/b/c', "x']{}", 'A', 'a b', '/a', 'a/'])
      expect(() => themeCss(id, diamond, diamondStructure), id).toThrow()
  })
})
