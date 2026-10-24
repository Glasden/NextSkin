import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

// 部署文档截图的公共部分（见同目录 README）：browser.ts 起浏览器，shoot.ts、annotate.ts 经 CDP 连上来

export const CDP_PORT = 9333
/** 截图的视口；像素密度是 1，和插槽一览的桌面端一样 */
export const VIEWPORT = { width: 1280, height: 800 }
/** 成品：文档页按相对路径引用 */
export const assets = fileURLToPath(new URL('../../src/assets/install/', import.meta.url))
/** 浏览器的 profile、字体配置和临时截图，不进仓库 */
export const cache = fileURLToPath(new URL('.cache/', import.meta.url))

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** 一个标注：视口坐标（CSS 像素）里的方框 */
export interface Mark extends Box {
  /** 序号，和图下面列表的编号对应；不给就只画框 */
  n?: number
  /** 序号放在哪，默认左上角；目标挨着视口上边时用 left、right */
  side?: 'top-left' | 'top-right' | 'left' | 'right'
  /** 框离目标的距离，默认 6 */
  pad?: number
}

/** 和插槽一览（screenshots/slots.spec.ts）同一套样式：3px 黑框加 2px 白描边，24px 高的黑底白字序号 */
export async function drawMarks(page: Page, marks: Mark[]): Promise<void> {
  await page.evaluate((marks) => {
    const border = 3
    let layer = document.getElementById('__marks')
    if (!layer) {
      layer = document.createElement('div')
      layer.id = '__marks'
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
      document.documentElement.append(layer)
    }
    for (const { x, y, width, height, n, side = 'top-left', pad = 6 } of marks) {
      const frame = document.createElement('div')
      frame.style.cssText = [
        'position:absolute',
        'box-sizing:border-box',
        `top:${y - pad - border}px`,
        `left:${x - pad - border}px`,
        `width:${width + 2 * (pad + border)}px`,
        `height:${height + 2 * (pad + border)}px`,
        `border:${border}px solid #000`,
        'box-shadow:0 0 0 2px #fff',
      ].join(';')
      if (n !== undefined) {
        const badge = document.createElement('div')
        badge.textContent = String(n)
        const position = {
          'top-left': `top:${border - 24}px;left:${-border}px`,
          'top-right': `top:${border - 24}px;right:${-border}px`,
          left: `top:${-border}px;right:calc(100% + 2px)`,
          right: `top:${-border}px;left:calc(100% + 2px)`,
        }[side]
        badge.style.cssText = [
          'position:absolute',
          'box-sizing:border-box',
          'height:24px',
          'min-width:24px',
          'padding:0 7px',
          position,
          'background:#000',
          'color:#fff',
          'box-shadow:0 0 0 2px #fff',
          'font:700 16px/24px system-ui,sans-serif',
          'text-align:center',
          'white-space:nowrap',
        ].join(';')
        frame.append(badge)
      }
      layer.append(frame)
    }
  }, marks)
}

export async function clearMarks(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('__marks')?.remove())
}
