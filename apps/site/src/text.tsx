import type { Page } from './scenes/page.ts'

/** 页的文字里，反引号括起来的是代码 */
export function Rich({ text }: { text: string }) {
  return text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))
}

/** 一页的正文：手机上的静帧下面、桌面上的读屏文本都用它 */
export function PageBody({ page }: { page: Page }) {
  return page.text.body.map((p, i) => (
    <p key={i}>
      <Rich text={p} />
    </p>
  ))
}
