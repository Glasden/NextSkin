/**
 * S3 端到端检查。先运行 scripts/gen-shims.ts、scripts/build-plugins.ts，再启动宿主（dev 或 build + start）
 * 和 scripts/xorigin-server.ts，然后：S3_MODE=<dev|turbopack|webpack> npx playwright test
 */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test as base, type Page } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')
const mode = process.env.S3_MODE ?? 'adhoc'
const dev = mode.startsWith('dev')

interface ShimManifest {
  readonly reactVersion: string
  readonly imports: Record<string, string>
  readonly keys: Record<string, { dev: string[]; prod: string[] }>
}
const shimManifest = async () => JSON.parse(await readFile(path.join(root, 'data/shims/manifest.json'), 'utf8')) as ShimManifest
const setActive = (versions: Record<string, string>) => writeFile(path.join(root, 'data/plugins/active.json'), JSON.stringify(versions))

/** 每个测试收集控制台错误、未捕获异常和 CSP 违规 */
const test = base.extend<{ diag: { console: string[]; pageErrors: string[]; page: Page } }>({
  diag: async ({ page }, use) => {
    const diag = { console: [] as string[], pageErrors: [] as string[], page }
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') diag.console.push(`[${m.type()}] ${m.text()}`)
    })
    page.on('pageerror', (e) => diag.pageErrors.push(e.message))
    await page.addInitScript(() => {
      const w = window as unknown as { __violations: string[] }
      w.__violations = []
      document.addEventListener('securitypolicyviolation', (e) => {
        const el = e.target as Element | null
        w.__violations.push(`${e.violatedDirective} ${e.blockedURI} <${el?.tagName ?? '?'}>`)
      })
    })
    await use(diag)
  },
})

test.beforeEach(async () => {
  await setActive({})
})
test.afterAll(async () => {
  await setActive({})
})

const plugin = (page: Page, id: string, slot = 'user.dashboard') => page.locator(`[data-slot="${slot}"] [data-plugin="${id}"]`)

async function openHome(page: Page) {
  await page.goto('/')
  await expect(plugin(page, 'hello').getByTestId('hello-meta')).toBeVisible()
}

const INTERNALS = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'

test('共享实例：插件拿到的 react / react-dom / jsx-runtime / @nextskin/* 就是宿主 App Router 用的那一份', async ({ page }) => {
  // 假的 React DevTools 钩子：渲染器（react-dom）启动时把自己用的 React 内部对象（currentDispatcherRef）交给它，
  // 每次提交时告诉它提交的是哪个根。dev 模式下 Next 开发工具的浮层是另一个渲染器，所以按根容器找出渲染页面的那一个
  await page.addInitScript(() => {
    const renderers = new Map<number, unknown>()
    const containers = new Map<number, Set<Node>>()
    ;(window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers,
      containers,
      inject(internals: unknown) {
        renderers.set(renderers.size + 1, internals)
        return renderers.size
      },
      onCommitFiberRoot(id: number, root: { containerInfo: Node }) {
        if (!containers.has(id)) containers.set(id, new Set())
        containers.get(id)!.add(root.containerInfo)
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    }
  })
  await openHome(page)
  const manifest = await shimManifest()
  const result = await page.evaluate(async ([url, internalsKey]) => {
    const shared = (globalThis as unknown as Record<symbol, Record<string, Record<string, unknown>>>)[Symbol.for('nextskin.shared')]!
    // 与插槽加载的是同一个 URL，module map 里是同一份模块记录
    const mod = (await import(url!)) as { probe: Record<string, Record<string, unknown>> }
    const p = mod.probe
    const hook = (
      window as unknown as {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: {
          renderers: Map<number, { currentDispatcherRef: unknown; version: string }>
          containers: Map<number, Set<Node>>
        }
      }
    ).__REACT_DEVTOOLS_GLOBAL_HOOK__
    const slot = document.querySelector('[data-slot="user.dashboard"]')!
    const pageRenderers = [...hook.renderers.entries()].filter(([id]) => [...(hook.containers.get(id) ?? [])].some((c) => c.contains(slot)))
    const renderer = pageRenderers[0]?.[1]
    return {
      // 渲染插槽的渲染器只有一个，它用的 React 内部对象就是插件经 shim 拿到的那个
      pageRenderers: pageRenderers.length,
      rendererVersion: renderer?.version,
      rendererSharesPluginReact: renderer !== undefined && renderer.currentDispatcherRef === p.React![internalsKey!],
      registeredIsRendererReact: renderer !== undefined && renderer.currentDispatcherRef === shared.react![internalsKey!],
      // 具名导入和默认导入（import React from 'react'）拿到的都是宿主的函数
      react: p.React!.useState === shared.react!.useState && (p.React!.default as Record<string, unknown>).useState === shared.react!.useState,
      jsx: (p as unknown as Record<string, unknown>).jsx === shared['react/jsx-runtime']!.jsx,
      reactDom: p.ReactDOM!.createPortal === shared['react-dom']!.createPortal,
      ui: p.Ui!.Dialog === shared['@nextskin/ui']!.Dialog,
      client: p.Client!.usePlugin === shared['@nextskin/plugin-client']!.usePlugin,
      version: shared.react!.version,
    }
  }, ['/plugins-assets/hello/1.0.0/client.js', INTERNALS])
  expect(result).toEqual({
    pageRenderers: 1,
    rendererVersion: manifest.reactVersion,
    rendererSharesPluginReact: true,
    registeredIsRendererReact: true,
    react: true,
    jsx: true,
    reactDom: true,
    ui: true,
    client: true,
    version: manifest.reactVersion,
  })
  // Next 自带的是 canary 版本，不是 node_modules 里的 react
  const npmReact = JSON.parse(await readFile(path.join(root, 'node_modules/react/package.json'), 'utf8')) as { version: string }
  expect(result.version).not.toBe(npmReact.version)

  // 插件包里没有 React 本身
  const hello = await readFile(path.join(root, 'data/plugins/hello/1.0.0/client.js'), 'utf8')
  const bundled = await readFile(path.join(root, 'data/plugins/bundled-react/1.0.0/client.js'), 'utf8')
  expect(hello).not.toContain('react.transitional.element')
  expect(bundled).toContain('react.transitional.element')
})

test('hooks、transition、Suspense + use()、context、portal、宿主组件（Base UI 对话框）都正常', async ({ page }) => {
  await openHome(page)
  const hello = plugin(page, 'hello')
  await expect(hello.getByTestId('hello-meta')).toHaveAttribute('data-effect', 'true')
  await expect(hello.getByTestId('hello-meta')).toHaveAttribute('data-plugin-id', 'hello')
  await expect(hello.getByTestId('hello-meta')).toHaveAttribute('data-slot', 'user.dashboard')

  await hello.getByTestId('hello-count').click()
  await expect(hello.getByTestId('hello-count')).toHaveText('点了 1 次')
  await hello.getByTestId('hello-transition').click()
  await expect(hello.getByTestId('hello-count')).toHaveText('点了 11 次')
  await hello.getByTestId('hello-input').fill('材质')
  await expect(hello.getByTestId('hello-echo')).toHaveText('材质')

  await expect(hello.getByTestId('hello-greeting')).toHaveText('来自 hello 的问候')
  await expect(hello.getByTestId('hello-portal-host').getByTestId('hello-portal')).toHaveText('portal 内容')

  const trigger = hello.getByRole('button', { name: '打开对话框' })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '插件对话框' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('hello-dialog-body')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()

  // 同一个插件在另一个插槽，拿到插槽传来的 props 和自己的 context
  const footer = plugin(page, 'hello', 'player.card.footer').getByTestId('hello-player')
  await expect(footer).toHaveText('Steve · hello 1.0.0')
  await expect(footer).toHaveAttribute('data-slot', 'player.card.footer')
})

const broken: Record<string, { name: string; message?: RegExp }> = {
  'render-throw': { name: 'Error', message: /render-throw/ },
  'bundled-react': { name: 'TypeError', message: /useState/ },
  'bare-import': { name: 'TypeError', message: /left-pad/ },
  'missing-export': { name: 'SyntaxError', message: /useNotARealHook/ },
  'eval-throw': { name: 'Error', message: /eval-throw/ },
  tampered: { name: 'TypeError' },
  'missing-file': { name: 'TypeError' },
  'wrong-export': { name: 'PluginLoadError', message: /没有导出组件 Widget/ },
  hang: { name: 'PluginLoadError', message: /加载超时/ },
  'effect-throw': { name: 'Error', message: /effect-throw/ },
  // 模块加载完成后组件自己挂起：由骨架的计时兜底
  'suspend-forever': { name: 'PluginLoadError', message: /加载超时/ },
}

test('出错的插件各自停在自己的边界里，宿主和其他插件不受影响', async ({ page, diag }) => {
  await openHome(page)
  for (const [id, expected] of Object.entries(broken)) {
    const error = plugin(page, id).locator('[data-slot-state="error"]')
    await expect(error, id).toBeVisible({ timeout: ['hang', 'suspend-forever'].includes(id) ? 20_000 : 15_000 })
    await expect(error, id).toHaveAttribute('data-error-name', expected.name)
    if (expected.message) await expect(error, id).toHaveAttribute('data-error', expected.message)
  }
  // 被篡改的文件没有执行
  expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__s3_tampered)).toBeUndefined()

  // 宿主仍然可以交互
  await page.getByTestId('host-count').click()
  await expect(page.getByTestId('host-count')).toHaveText('宿主计数 1')

  // 事件处理函数里的错误：不触发边界，组件保持原样，错误进入 window 的 error 事件
  await plugin(page, 'event-throw').getByTestId('event-throw').click()
  await expect.poll(() => diag.pageErrors.some((m) => m.includes('event-throw'))).toBe(true)
  await expect(plugin(page, 'event-throw').getByTestId('event-throw')).toBeVisible()
  await expect(plugin(page, 'event-throw').locator('[data-slot-state="error"]')).toHaveCount(0)

  await plugin(page, 'hello').getByTestId('hello-count').click()
  await expect(plugin(page, 'hello').getByTestId('hello-count')).toHaveText('点了 1 次')
})

test('服务端只渲染骨架，不执行插件代码；水合没有告警', async ({ page, request, diag }) => {
  const html = await (await request.get('/')).text()
  expect(html).toContain('<script type="importmap"')
  expect(html).toContain('data-slot-state="loading"')
  expect(html).not.toContain('hello-meta')

  await openHome(page)
  await expect(plugin(page, 'styled').getByTestId('styled-grid')).toBeVisible()
  const hydration = diag.console.filter((m) => /hydrat|did not match|server rendered html/i.test(m))
  expect(hydration).toEqual([])
})

test('软导航：import map 继续生效，插件在新页面的插槽里渲染，页面没有整页刷新', async ({ page }) => {
  await openHome(page)
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1))
  await plugin(page, 'hello').getByTestId('hello-navigate').click()
  await expect(page).toHaveURL(/\/other$/)
  const other = plugin(page, 'hello', 'user.profile.sections')
  await expect(other.getByTestId('hello-meta')).toHaveAttribute('data-slot', 'user.profile.sections')
  await page.getByRole('link', { name: '首页' }).click()
  await expect(plugin(page, 'hello').getByTestId('hello-meta')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1)
})

test('插件换代（integrity 写在 import map 里）：不刷新时提示刷新，刷新后加载新版本', async ({ page }) => {
  await openHome(page)
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1))
  await setActive({ hello: '1.1.0' })
  await page.getByTestId('host-refresh').click()
  const reload = plugin(page, 'hello').locator('[data-slot-state="reload"]')
  await expect(reload).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1)
  // 其他插件不受影响
  await expect(plugin(page, 'styled').getByTestId('styled-grid')).toBeVisible()

  await reload.getByRole('button', { name: '刷新页面' }).click()
  await expect(plugin(page, 'hello').getByTestId('hello-meta')).toHaveAttribute('data-version', '1.1.0')
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBeUndefined()
})

test('插件换代（不校验 integrity 时）：不刷新页面直接换成新版本', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 's3-sri', value: 'none', url: baseURL! }])
  await openHome(page)
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1))
  await setActive({ hello: '1.1.0' })
  await page.getByTestId('host-refresh').click()
  await expect(plugin(page, 'hello').getByTestId('hello-meta')).toHaveAttribute('data-version', '1.1.0')
  await expect(plugin(page, 'hello', 'player.card.footer').getByTestId('hello-player')).toHaveText('Steve · hello 1.1.0')
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1)
  // 不校验时，被篡改的文件会执行：对照组
  await expect.poll(() => page.evaluate(() => (globalThis as Record<string, unknown>).__s3_tampered)).toBe(true)
})

test('CSP：nonce 加到了 import map 上，插件加载过程没有违规', async ({ page, diag }) => {
  const response = await page.goto('/')
  const csp = response!.headers()['content-security-policy'] ?? ''
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
  await expect(plugin(page, 'hello').getByTestId('hello-meta')).toBeVisible()
  await expect(plugin(page, 'styled').getByTestId('styled-grid')).toBeVisible()
  const violations = await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)
  // dev 模式下 Next 开发工具（<nextjs-portal>）自己的内联样式会违反 style-src，与插件无关
  const relevant = violations.filter((v) => !(dev && /^style-src/.test(v)))
  expect(relevant).toEqual([])
  expect(diag.pageErrors).toEqual([])
})

test('CSP 探测：已经在主域运行的插件代码，CSP 能挡住什么', async ({ page, request }, testInfo) => {
  await request.get('http://127.0.0.1:3301/reset')
  await page.goto('/csp-probe')
  const dynamic = page.getByTestId('xorigin-dynamic')
  await expect(dynamic).toHaveAttribute('data-done', 'true')
  const staticState = await plugin(page, 'xorigin-static', 'admin.dashboard').getByTestId('xorigin-static').getAttribute('data-ran')
  const outcome = await dynamic.evaluate((el) => ({ ...(el as HTMLElement).dataset }))
  const seen = (await (await request.get('http://127.0.0.1:3301/log')).json()) as string[]
  const result = {
    staticImport: staticState === 'true' ? 'ok' : 'blocked',
    dynamicImport: outcome.dynamicImport,
    scriptNoNonce: outcome.scriptNoNonce,
    scriptWithNonce: outcome.scriptWithNonce,
    nonceReadable: outcome.nonceReadable,
    fetch: outcome.fetch,
    fetchLeftBrowser: seen.includes('/fetch'),
    image: outcome.image,
  }
  testInfo.annotations.push({ type: 'csp-probe', description: JSON.stringify(result) })
  // 加载脚本这一类全部挡不住：插件读得到 nonce，'strict-dynamic' 又信任受信脚本创建的脚本
  expect(result).toMatchObject({ staticImport: 'ok', dynamicImport: 'ok', scriptNoNonce: 'ok', scriptWithNonce: 'ok', nonceReadable: 'ok', image: 'blocked' })
})

test('样式：插件自带的工具类用上宿主 token，并随暗色模式切换', async ({ page }) => {
  await openHome(page)
  const grid = plugin(page, 'styled').getByTestId('styled-grid')
  await expect(grid).toBeVisible()
  const read = () =>
    grid.evaluate((el) => {
      const s = getComputedStyle(el)
      return { columns: s.gridTemplateColumns.split(' ').length, style: s.borderTopStyle, color: s.borderTopColor }
    })
  expect(await read()).toEqual({ columns: 7, style: 'dashed', color: 'rgb(184, 110, 0)' })
  const button = plugin(page, 'hello').getByTestId('hello-count')
  await expect(button).toHaveCSS('background-color', 'rgb(47, 109, 246)')

  await page.getByTestId('theme-toggle').click()
  expect(await read()).toEqual({ columns: 7, style: 'solid', color: 'rgb(240, 165, 58)' })
  await expect(button).toHaveCSS('background-color', 'rgb(111, 155, 255)')

  // 宿主 CSS 里没有插件用到的这些工具类：插件必须自带 CSS
  const hostHas = await page.evaluate(() =>
    [...document.styleSheets]
      .filter((s) => !s.href?.includes('/plugins-assets/'))
      .some((s) => [...s.cssRules].some((r) => r.cssText.includes('grid-cols-7'))),
  )
  expect(hostHas).toBe(false)
  await expect(page.locator('link[rel="stylesheet"][data-plugin-stylesheet]')).toHaveCount(1)

  // 插件 CSS 只有工具类：没有 preflight，也不重新定义 token
  const css = await readFile(path.join(root, 'data/plugins/styled/1.0.0/client.css'), 'utf8')
  expect(css).not.toContain(':root')
  expect(css).not.toContain('box-sizing')
  expect(css).not.toMatch(/--color-[a-z-]+:/)
})

test('shim 的导出与宿主实际对象的键完全一致（Next 升级后的回归检查）', async ({ page }) => {
  await openHome(page)
  const manifest = await shimManifest()
  const actual = await page.evaluate(async (imports) => {
    const shared = (globalThis as unknown as Record<symbol, Record<string, Record<string, unknown>>>)[Symbol.for('nextskin.shared')]!
    const out: Record<string, { host: string[]; shim: string[] }> = {}
    for (const [name, url] of Object.entries(imports)) {
      out[name] = {
        host: Object.keys(shared[name]!).filter((k) => k !== 'default' && k !== '__esModule').sort(),
        shim: Object.keys(await import(url)).filter((k) => k !== 'default').sort(),
      }
    }
    return out
  }, manifest.imports)
  for (const [name, { host, shim }] of Object.entries(actual)) {
    const expected = manifest.keys[name]!
    // dev 模式跑的是开发版 React，生产构建跑的是生产版：宿主对象的键必须与生成 shim 时记下的那一份完全相同
    expect(host, `${name} 的键与生成 shim 时不同，需要重新运行 gen-shims`).toEqual(dev ? expected.dev : expected.prod)
    expect(shim, `${name} 的 shim 应导出开发版与生产版的并集`).toEqual([...new Set([...expected.dev, ...expected.prod])].sort())
  }
})

function headOrder(html: string) {
  const head = html.slice(0, html.indexOf('</head>'))
  const map = head.indexOf('<script type="importmap"')
  const firstModule = Math.min(...[head.indexOf('rel="modulepreload"'), head.indexOf('type="module"')].map((i) => (i === -1 ? Infinity : i)))
  return { map, firstModule }
}

test('守护：HTML 里 import map 之前没有任何 modulepreload 或模块脚本', async ({ request }) => {
  const { map, firstModule } = headOrder(await (await request.get('/')).text())
  expect(map).toBeGreaterThan(-1)
  expect(firstModule).toBeGreaterThan(map)
})

test('反例：JSX 里的 <link rel="modulepreload"> 会被 React 提到 import map 前面', async ({ page, context, request, baseURL, browserName, diag }) => {
  await context.addCookies([{ name: 's3-ssr-preload', value: 'link', url: baseURL! }])
  const { map, firstModule } = headOrder(await (await request.get('/', { headers: { cookie: 's3-ssr-preload=link' } })).text())
  expect(firstModule).toBeLessThan(map)
  await page.goto('/')
  const hello = plugin(page, 'hello')
  if (browserName === 'firefox') {
    // Firefox：预加载开始之后出现的 import map 整个被丢弃，裸模块名全部解析失败
    await expect(hello.locator('[data-slot-state="error"]')).toHaveAttribute('data-error', /react/)
    expect(diag.console.some((m) => /Import maps are not allowed after a module load or preload has started/.test(m))).toBe(true)
  } else if (browserName === 'chromium') {
    // Chromium：映射生效，但预加载发生在 integrity 登记之前，被篡改的文件照样执行
    await expect(hello.getByTestId('hello-meta')).toBeVisible()
    await expect.poll(() => page.evaluate(() => (globalThis as Record<string, unknown>).__s3_tampered)).toBe(true)
  } else {
    await expect(hello.getByTestId('hello-meta')).toBeVisible()
    await expect(plugin(page, 'tampered').locator('[data-slot-state="error"]')).toBeVisible()
  }
})

test('服务端组件里调用 preloadModule()：提示由客户端在 import map 之后插入，三个引擎都安全', async ({ page, context, request, baseURL }) => {
  await context.addCookies([{ name: 's3-ssr-preload', value: 'hint', url: baseURL! }])
  const { map, firstModule } = headOrder(await (await request.get('/', { headers: { cookie: 's3-ssr-preload=hint' } })).text())
  expect(firstModule).toBeGreaterThan(map)
  await openHome(page)
  await expect(page.locator('link[rel="modulepreload"][href="/plugins-assets/hello/1.0.0/client.js"]')).toHaveCount(1)
  await expect(plugin(page, 'tampered').locator('[data-slot-state="error"]')).toBeVisible()
  expect(await page.evaluate(() => (globalThis as Record<string, unknown>).__s3_tampered)).toBeUndefined()
})

for (const failure of ['integrity', 'not-found', 'hang'] as const) {
  test(`插件样式表出错（${failure}）：只影响这个插件，进入它的错误边界`, async ({ page }) => {
    await page.route('**/plugins-assets/styled/1.0.0/client.css', async (route) => {
      if (failure === 'hang') return // 永远不响应
      await route.fulfill({ status: failure === 'not-found' ? 404 : 200, contentType: 'text/css', body: '.x { color: red }' })
    })
    await page.goto('/')
    // 其他插件不被拖住
    await expect(plugin(page, 'hello').getByTestId('hello-meta')).toBeVisible()
    const error = plugin(page, 'styled').locator('[data-slot-state="error"]')
    await expect(error).toBeVisible({ timeout: 20_000 })
    await expect(error).toHaveAttribute('data-error', failure === 'hang' ? /加载超时/ : /样式表加载失败/)
    await expect(plugin(page, 'styled').getByTestId('styled-grid')).toHaveCount(0)
  })
}

test('安装检查：正常插件的入口只导入共享模块；故意违规的夹具被标出', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', '与浏览器无关，只跑一次')
  const installed = JSON.parse(await readFile(path.join(root, 'data/plugins/installed.json'), 'utf8')) as {
    plugins: Record<string, { versions: Record<string, { foreignImports: string[] }> }>
  }
  const flagged = Object.fromEntries(
    Object.entries(installed.plugins).flatMap(([id, p]) =>
      Object.values(p.versions)
        .filter((v) => v.foreignImports.length > 0)
        .map((v) => [id, v.foreignImports]),
    ),
  )
  expect(flagged).toEqual({
    'bare-import': ['left-pad'],
    'xorigin-dynamic': ['import(…)'],
    'xorigin-static': ['http://127.0.0.1:3301/static.js'],
  })
})

test('资源路由：符号链接指向 data/ 以外时返回 404', async ({ request, browserName }) => {
  test.skip(browserName !== 'chromium', '与浏览器无关，只跑一次')
  const dir = path.join(root, 'data/plugins/symlink-probe/1.0.0')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'inside.js'), 'export {}\n')
  await rm(path.join(dir, 'client.js'), { force: true })
  await symlink(path.join(root, 'package.json'), path.join(dir, 'client.js'))
  try {
    expect((await request.get('/plugins-assets/symlink-probe/1.0.0/inside.js')).status()).toBe(200)
    expect((await request.get('/plugins-assets/symlink-probe/1.0.0/client.js')).status()).toBe(404)
  } finally {
    await rm(path.join(root, 'data/plugins/symlink-probe'), { recursive: true, force: true })
  }
})

for (const preload of ['off', 'hint'] as const) {
  test(`性能：插件资源的请求时间和可交互时间（preloadModule 提示：${preload}）`, async ({ page, context, baseURL }, testInfo) => {
    if (preload === 'hint') await context.addCookies([{ name: 's3-ssr-preload', value: 'hint', url: baseURL! }])
    await page.goto('/')
    const timing = await page.evaluate(async () => {
      while (!document.querySelector('[data-testid="hello-meta"][data-effect="true"]')) await new Promise((r) => setTimeout(r, 5))
      const readyAt = performance.now()
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
      const assets = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((e) => e.name.includes('/plugins-assets/'))
      // hello 自己和它依赖的 shim
      const hello = assets.filter((e) => /\/hello\/1\.0\.0\/client\.js$|\/_shared\//.test(e.name))
      const first = Math.min(...hello.map((e) => e.startTime))
      return {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        firstRequestMs: Math.round(first),
        fetchWindowMs: Math.round(Math.max(...hello.map((e) => e.responseEnd)) - first),
        // 包含 React 19 对 Suspense 揭示的节流（FALLBACK_THROTTLE_MS = 300）
        readyMs: Math.round(readyAt),
        pluginAssets: assets.length,
        pluginBytes: assets.reduce((n, e) => n + e.encodedBodySize, 0),
      }
    })
    testInfo.annotations.push({ type: 'perf', description: JSON.stringify({ preload, ...timing }) })
    expect(timing.pluginAssets).toBeGreaterThan(0)
  })
}
