// 拼邮件 HTML 的标签模板（ADR-0020）：插入的值默认按 HTML 转义，只有 markup`` 自己生成的片段原样插入，
// 这样漏写转义的地方不会出现。不叫 html：Prettier 会把 html`` 里的内容当成 HTML 重新排版，改变输出。

const SAFE = Symbol('safe html')

export interface SafeHtml {
  readonly [SAFE]: string
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )
}

/** 可以插入的值：文字和数字会被转义；null、undefined、false 不输出，方便写条件片段 */
export type Interpolation = string | number | SafeHtml | null | undefined | false | readonly Interpolation[]

function serialize(value: Interpolation): string {
  if (value === null || value === undefined || value === false) return ''
  if (typeof value === 'string' || typeof value === 'number') return escape(String(value))
  if (Array.isArray(value)) return (value as readonly Interpolation[]).map(serialize).join('')
  // 手写 JS 的调用方可能传进别的对象：不是 markup`` 生成的，直接报错，不去猜它该怎么输出
  if (SAFE in value) return value[SAFE]
  throw new TypeError('markup`` 只能插入文字、数字和 markup`` 片段')
}

export function markup(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0]!
  values.forEach((value, index) => {
    out += serialize(value) + strings[index + 1]!
  })
  return { [SAFE]: out }
}

export function toString(fragment: SafeHtml): string {
  return fragment[SAFE]
}

/** 内联样式。数字按 px 处理；结果作为属性值插入时照常转义 */
export function style(declarations: Readonly<Record<string, string | number>>): string {
  return Object.entries(declarations)
    .map(([property, value]) => {
      const name = property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
      return `${name}:${typeof value === 'number' && value !== 0 ? `${value}px` : value}`
    })
    .join(';')
}
