import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// 每个 story 拍亮色、暗色两张截图（DESIGN.md §12）。story 清单取自 storybook-static/index.json，
// 新增的 story 不用在这里登记；改了外观要用 `pnpm test:visual -- --update-snapshots` 更新基线
interface IndexEntry {
  id: string
  title: string
  name: string
  type: 'story' | 'docs'
  tags?: string[]
}

const index = JSON.parse(readFileSync(new URL('../storybook-static/index.json', import.meta.url), 'utf8')) as {
  entries: Record<string, IndexEntry>
}
const stories = Object.values(index.entries).filter((entry) => entry.type === 'story')

for (const story of stories) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${story.title} / ${story.name}（${theme}）`, async ({ page }) => {
      // 通知、对话框这类浮层渲染在 body 下、按视口定位，这类 story 带 screenshot-viewport 标签，截整个视口
      const wholeViewport = story.tags?.includes('screenshot-viewport') ?? false
      if (wholeViewport) await page.setViewportSize({ width: 720, height: 480 })
      // play 函数失败时 phase 照样是 finished、截图照拍，只有 Storybook 的事件里看得出来：
      // 预览一建好通道就挂上监听，记下 play 抛出的错误
      await page.addInitScript(() => {
        const preview = window as { playError?: string }
        let channel: unknown
        Object.defineProperty(window, '__STORYBOOK_ADDONS_CHANNEL__', {
          configurable: true,
          get: () => channel,
          set(next: { on(event: string, listener: (error: { message: string }) => void): void }) {
            channel = next
            next.on('playFunctionThrewException', (error) => (preview.playError = error.message))
          },
        })
      })
      await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`)
      // play 函数可能留下焦点之类的状态，等它跑完再截图；它失败时截图没有意义
      const phase = await page.waitForFunction(() => {
        const preview = (window as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } })
          .__STORYBOOK_PREVIEW__
        const phase = preview?.currentRender?.phase
        return phase && ['finished', 'errored', 'aborted'].includes(phase) ? phase : false
      })
      expect(await phase.jsonValue()).toBe('finished')
      expect(await page.evaluate(() => (window as { playError?: string }).playError), 'play 函数失败').toBeUndefined()
      await page.evaluate(() => document.fonts.ready)
      const name = `${story.id}--${theme}.png`
      if (wholeViewport) await expect(page).toHaveScreenshot(name)
      else await expect(page.locator('[data-screenshot]')).toHaveScreenshot(name)
    })
  }
}
