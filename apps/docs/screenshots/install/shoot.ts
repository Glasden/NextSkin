import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { assets, cache, CDP_PORT, clearMarks, drawMarks, VIEWPORT, type Box, type Mark } from './common.ts'

// 用法：node screenshots/install/shoot.ts <步骤脚本> [参数…]
// 连上 browser.ts 起的浏览器，在最后一个标签页上运行步骤脚本。步骤脚本默认导出 async (helpers: Helpers) => {}，
// 一次只做一小步（点开一个对话框、填一张表、截一张图），失败了改了重跑；脚本只为一个面板版本写，不进仓库（见 README）

/** 标注的目标：locator 或视口坐标里的方框，序号、位置和间距同 Mark */
export type Target = Omit<Mark, keyof Box> & ({ at: Locator } | { box: Box })

export interface Helpers {
  page: Page
  context: BrowserContext
  /** 命令行上步骤脚本后面的参数 */
  args: string[]
  /** 给每个目标画一圈黑框和序号；截完图用 clearMarks 去掉 */
  mark(targets: Target[]): Promise<void>
  clearMarks(): Promise<void>
  /** 把页面上（含同源 iframe）的文字、输入框和 title、placeholder 里匹配的内容换掉：[[正则源码, 替换], …] */
  redact(rules: [pattern: string, replacement: string][]): Promise<void>
  /** 截成品，写到 src/assets/install/<name>.png；clip 是视口坐标，element 截它所在的区域并在四周留 margin */
  shot(name: string, options?: { clip?: Box; element?: Locator; margin?: number }): Promise<string>
  /** 看页面用的临时截图，写到 .cache/snaps/ */
  snap(name?: string): Promise<string>
}

export type Step = (helpers: Helpers) => Promise<void>

const [stepFile, ...args] = process.argv.slice(2)
if (!stepFile) throw new Error('用法：node screenshots/install/shoot.ts <步骤脚本> [参数…]')

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
const context = browser.contexts()[0]
const last = context?.pages().at(-1)
if (!context || !last) throw new Error('浏览器里没有标签页：先运行 browser.ts')
const page: Page = last
await page.setViewportSize({
  width: Number(process.env.VW ?? VIEWPORT.width),
  height: Number(process.env.VH ?? VIEWPORT.height),
})

async function mark(targets: Target[]): Promise<void> {
  const marks: Mark[] = []
  for (const target of targets) {
    const box = 'box' in target ? target.box : await target.at.boundingBox()
    if (!box) throw new Error(`标注的目标不可见：${'at' in target ? String(target.at) : ''}`)
    marks.push({ ...box, n: target.n, side: target.side, pad: target.pad })
  }
  await drawMarks(page, marks)
}

async function redact(rules: [string, string][]): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate((rules) => {
        const patterns = rules.map(([source, to]) => [new RegExp(source, 'g'), to] as const)
        const apply = (text: string) => patterns.reduce((value, [pattern, to]) => value.replace(pattern, to), text)
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const next = apply(node.nodeValue ?? '')
          if (next !== node.nodeValue) node.nodeValue = next
        }
        for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
          const next = apply(input.value)
          if (next !== input.value) input.value = next
        }
        for (const element of document.querySelectorAll('[title], [placeholder]'))
          for (const attribute of ['title', 'placeholder']) {
            const value = element.getAttribute(attribute)
            if (value && apply(value) !== value) element.setAttribute(attribute, apply(value))
          }
      }, rules)
      // 跨域的 iframe 进不去，跳过
      .catch(() => {})
  }
}

async function shot(name: string, options: { clip?: Box; element?: Locator; margin?: number } = {}): Promise<string> {
  const path = join(assets, `${name}.png`)
  mkdirSync(dirname(path), { recursive: true })
  let clip = options.clip
  if (options.element) {
    const box = await options.element.boundingBox()
    if (!box) throw new Error(`要截的元素不可见：${String(options.element)}`)
    const margin = options.margin ?? 16
    const viewport = page.viewportSize() ?? VIEWPORT
    const x = Math.max(0, box.x - margin)
    const y = Math.max(0, box.y - margin)
    clip = {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + 2 * margin),
      height: Math.min(viewport.height - y, box.height + 2 * margin),
    }
  }
  await page.screenshot({ path, clip, animations: 'disabled', caret: 'hide' })
  console.log('成品', path)
  return path
}

async function snap(name = 'snap'): Promise<string> {
  const path = join(cache, 'snaps', `${name}.png`)
  mkdirSync(dirname(path), { recursive: true })
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' })
  console.log('临时', path)
  return path
}

try {
  const step = (await import(pathToFileURL(resolve(stepFile)).href)) as { default: Step }
  await step.default({
    page,
    context,
    args,
    mark,
    clearMarks: () => clearMarks(page),
    redact,
    shot,
    snap,
  })
} finally {
  // 只断开 CDP，不关浏览器
  await browser.close().catch(() => {})
}
