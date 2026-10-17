import { expect, test } from 'vitest'
import { markup, style, toString } from './html.ts'

test('插入的值默认转义，markup`` 生成的片段原样插入', () => {
  const inner = markup`<b>${'<i>'}</b>`
  expect(toString(markup`<p title="${'"x"'}">${inner}${'&'}</p>`)).toBe(
    '<p title="&quot;x&quot;"><b>&lt;i&gt;</b>&amp;</p>',
  )
})

test('其他对象不会被当成安全片段，直接报错', () => {
  // 类型上不允许，模拟手写 JS 的调用方
  const forged = { toString: () => '<script>' } as unknown as string
  expect(() => markup`${forged}`).toThrow(TypeError)
})

test('数组逐项插入，null、undefined、false 不输出', () => {
  expect(toString(markup`${['a', markup`<br>`, null, undefined, false, 0]}`)).toBe('a<br>0')
})

test('内联样式：驼峰转连字符，数字按 px', () => {
  expect(style({ fontSize: 16, lineHeight: '24px', margin: 0, fontWeight: '500' })).toBe(
    'font-size:16px;line-height:24px;margin:0;font-weight:500',
  )
})
