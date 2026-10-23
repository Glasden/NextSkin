import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslator } from '@nextskin/i18n'
import { pluginSlots } from '@nextskin/plugin-host/slots'
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test'

// 插槽一览的截图（ADR-0060）：演示插件在每个插槽里放两个挂件，按页面截桌面端和手机两张，每个插槽一圈黑框加序号。
// 写出 src/assets/slots 里的图和清单 slots.json，scripts/sync.ts 按清单生成"插槽一览"，并比对登记表和清单

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const output = fileURLToPath(new URL('../src/assets/slots/', import.meta.url))
const launcher = join(repository, 'dist/nextskin/nextskin.mjs')
const email = 'steve@nextskin.test'
// 契约用例的固定数据里所有用户的密码（tests/contract/src/world.ts）
const password = 'nextskin-test'
const demoPlugin = 'slot-demo'
const t = createTranslator('zh-CN')

const devices = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} satisfies Record<string, BrowserContextOptions>
type Device = keyof typeof devices

/** 截到最下面那个插槽的下边，再多留这么多 */
const MARGIN_BELOW = 160
/** 黑框离插槽的距离和粗细 */
const FRAME_GAP = 6
const FRAME_WIDTH = 3

const slots = Object.entries(pluginSlots).map(([id, slot], index) => ({ number: index + 1, id, path: slot.path }))
const pages = [...new Set(slots.map((slot) => slot.path))].map((path) => ({
  path,
  key: path.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home',
  slots: slots.filter((slot) => slot.path === path),
}))

/** 对服务的数据目录执行命令行（ADR-0039），密钥同 playwright.config.ts */
function nextskin(...args: string[]): string {
  return execFileSync(process.execPath, [launcher, ...args], {
    env: {
      ...process.env,
      NEXTSKIN_DATA_DIR: process.env.NEXTSKIN_SCREENSHOTS_DATA_DIR,
      NEXTSKIN_SECRET: process.env.NEXTSKIN_SCREENSHOTS_SECRET,
    },
    encoding: 'utf8',
  })
}

/** 和插件作者一样用 nextskin-plugin build 打包演示插件 */
function buildDemoPlugin(): string {
  const out = join(mkdtempSync(join(tmpdir(), 'nextskin-docs-plugin-')), 'plugin.tgz')
  execFileSync(process.execPath, [
    join(repository, 'packages/plugin-cli/src/cli.ts'),
    'build',
    fileURLToPath(new URL('demo-plugin/', import.meta.url)),
    '--out',
    out,
  ])
  return out
}

async function api(page: Page, method: string, path: string, body: unknown) {
  // 在页面里发请求：浏览器在容器里，经它访问本机的服务，Cookie 也在它那里
  const result = await page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, text: await response.text() }
    },
    { method, path, body },
  )
  expect(result.status, `${method} ${path}：${result.text}`).toBe(200)
}

async function newContext(browser: Browser, device: Device, storageState?: BrowserContextOptions['storageState']) {
  const context = await browser.newContext({
    ...devices[device],
    locale: 'zh-CN',
    colorScheme: 'light',
    // 标注是往页面里插的元素，站点的 CSP（ADR-0053）不允许内联样式；只在截图时关掉
    bypassCSP: true,
    storageState,
  })
  await context.addCookies([{ name: 'nextskin-color-mode', value: 'light', url: test.info().project.use.baseURL! }])
  return context
}

/** 每个插槽外面一圈黑框，左上角一个序号；框外描一圈白边，压在深色内容上也看得见。返回插槽在页面上的范围 */
async function annotate(page: Page, marks: { number: number; id: string }[]) {
  return page.evaluate(
    ({ marks, gap, width }) => {
      const layer = document.createElement('div')
      layer.style.cssText = 'position:absolute;inset:0 auto auto 0;width:0;height:0;z-index:2147483647'
      document.body.append(layer)
      const boxes = marks.map(({ number, id }) => {
        const element = document.querySelector(`[data-plugin-slot="${id}"]`)
        if (!element) throw new Error(`页面上找不到插槽 ${id}`)
        const rect = element.getBoundingClientRect()
        const top = rect.top + window.scrollY
        const left = rect.left + window.scrollX
        const frame = document.createElement('div')
        frame.style.cssText = [
          'position:absolute',
          'box-sizing:border-box',
          `top:${top - gap - width}px`,
          `left:${left - gap - width}px`,
          `width:${rect.width + 2 * (gap + width)}px`,
          `height:${rect.height + 2 * (gap + width)}px`,
          `border:${width}px solid #000`,
          'box-shadow:0 0 0 2px #fff',
        ].join(';')
        const badge = document.createElement('div')
        badge.textContent = String(number)
        badge.style.cssText = [
          'position:absolute',
          'box-sizing:border-box',
          'height:24px',
          'min-width:24px',
          'padding:0 7px',
          `top:${-24 + width}px`,
          `left:${-width}px`,
          'background:#000',
          'color:#fff',
          'box-shadow:0 0 0 2px #fff',
          'font:700 16px/24px system-ui,sans-serif',
          'text-align:center',
        ].join(';')
        frame.append(badge)
        layer.append(frame)
        return { id, bottom: top + rect.height + gap + width }
      })
      return { boxes, height: document.documentElement.scrollHeight }
    },
    { marks, gap: FRAME_GAP, width: FRAME_WIDTH },
  )
}

test('插槽一览的截图', async ({ browser }) => {
  // 演示插件：打包、安装、启用。运行中的服务最多 5 秒后跟上（ADR-0049）
  nextskin('set-role', email, 'superadmin')
  nextskin('plugin', 'install', buildDemoPlugin(), '--yes')
  nextskin('plugin', 'enable', demoPlugin)

  const login = await newContext(browser, 'desktop')
  const page = await login.newPage()
  await page.goto('/sign-in')
  await api(page, 'POST', '/api/auth/sign-in/email', { email, password })
  const storageState = await login.storageState()
  await login.close()

  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const manifestPages = []
  for (const { path, key, slots: marks } of pages) {
    const shots: Record<string, { file: string; width: number }> = {}
    for (const device of Object.keys(devices) as Device[]) {
      const context = await newContext(browser, device, storageState)
      const page = await context.newPage()
      // 等服务接上演示插件：每个插槽里都有它的两个挂件，而且都取到了数据。plugin host 刚接上插件时，
      // 挂件会先显示"没能加载"
      await expect(async () => {
        await page.goto(path)
        for (const { id } of marks) {
          const slot = page.locator(`[data-plugin-slot="${id}"]`)
          await expect(slot.getByRole('region'), `插槽 ${id}`).toHaveCount(2, { timeout: 1000 })
          await expect(slot.getByText(t('pluginView.widgetLoadFailed')), `插槽 ${id}`).toHaveCount(0, { timeout: 1000 })
        }
      }).toPass({ timeout: 60_000 })
      for (const { id } of marks) await expect(page.locator(`[data-plugin-slot="${id}"]`)).toBeVisible()
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => document.fonts.ready)
      const { boxes, height } = await annotate(page, marks)
      const bottom = Math.max(...boxes.map((box) => box.bottom))
      const file = `${key}-${device}.png`
      const { width } = devices[device].viewport
      await page.screenshot({
        path: join(output, file),
        fullPage: true,
        clip: { x: 0, y: 0, width, height: Math.min(height, Math.ceil(bottom + MARGIN_BELOW)) },
        animations: 'disabled',
        caret: 'hide',
      })
      shots[device] = { file, width }
      await context.close()
    }
    manifestPages.push({ path, shots })
  }

  const nextskinVersion = (
    JSON.parse(readFileSync(join(repository, 'packages/launcher/package.json'), 'utf8')) as { version: string }
  ).version
  writeFileSync(
    join(output, 'slots.json'),
    `${JSON.stringify({ nextskin: nextskinVersion, slots, pages: manifestPages }, null, 2)}\n`,
  )
  expect(readdirSync(output).sort()).toEqual(
    [...manifestPages.flatMap((entry) => Object.values(entry.shots).map((shot) => shot.file)), 'slots.json'].sort(),
  )
})
