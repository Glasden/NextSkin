import { parseFragment } from 'parse5'

export interface ScriptAttributes {
  src?: string
  async?: true
  defer?: true
  type?: string
  crossorigin?: string
  referrerpolicy?: string
  integrity?: string
  charset?: string
  id?: string
  data: Record<string, string>
}

export type HeadElement =
  | { kind: 'script'; attributes: ScriptAttributes; code: string }
  | { kind: 'meta'; name?: string; property?: string; content: string }

export interface HeadCodeError {
  reason:
    | 'text'
    | 'tag'
    | 'attribute'
    | 'event_handler'
    | 'script_src'
    | 'script_src_and_code'
    | 'script_code'
    | 'script_type'
    | 'meta'
    | 'meta_reserved'
  line: number
  tag?: string
  attribute?: string
  value?: string
}

const scriptStrings = ['src', 'type', 'crossorigin', 'referrerpolicy', 'integrity', 'charset', 'id'] as const
const scriptTypes = new Set(['', 'text/javascript', 'module', 'application/json', 'application/ld+json'])
const reservedMeta = new Set([
  'viewport',
  'description',
  'keywords',
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
])

/** 只把允许的顶层节点交给页面渲染；脚本内容按源码截取，保留原文（ADR-0063）。 */
export function parseHeadCode(
  source: string,
): { ok: true; elements: HeadElement[] } | { ok: false; error: HeadCodeError } {
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true })
  const elements: HeadElement[] = []
  for (const node of fragment.childNodes) {
    const line = node.sourceCodeLocation?.startLine ?? 1
    if (node.nodeName === '#comment') continue
    if ('value' in node) {
      const offset = node.value.search(/\S/)
      if (offset < 0) continue
      return { ok: false, error: { reason: 'text', line: line + node.value.slice(0, offset).split('\n').length - 1 } }
    }
    if (!('tagName' in node)) continue
    const tag = node.tagName
    const invalid = (reason: HeadCodeError['reason'], details: Pick<HeadCodeError, 'attribute' | 'value'> = {}) =>
      ({ ok: false, error: { reason, line, tag, ...details } }) as const
    if (tag === 'noscript') continue
    if (tag === 'script') {
      const attributes: ScriptAttributes = { data: {} }
      for (const { name, value } of node.attrs) {
        if (name === 'nonce') continue
        if (name.startsWith('on')) return invalid('event_handler', { attribute: name })
        if (name === 'async' || name === 'defer') attributes[name] = true
        else if (/^data-[a-z0-9][a-z0-9._-]*$/.test(name)) attributes.data[name] = value
        else {
          const key = scriptStrings.find((key) => key === name)
          if (!key) return invalid('attribute', { attribute: name })
          attributes[key] = value
        }
      }
      if (attributes.src !== undefined) {
        attributes.src = attributes.src.trim()
        if (!/^(?:https?:)?\/\//i.test(attributes.src)) return invalid('script_src', { attribute: 'src' })
      }
      // 取标签里的文字，不按源码位置截：没写结束标签时 parse5 记的元素结束位置停在开始标签上，代码会被截成空的。
      // 和源码的差别只在换行统一成 \n，浏览器解析时也这样做
      const code = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('')
      if (attributes.src !== undefined && code.trim()) return invalid('script_src_and_code')
      // 渲染时代码原样放进 <script>…</script>。没配对的 `<!--<script>` 会让浏览器跳过这个结束标签，
      // 把后面的页面当成脚本吞掉：按渲染出来的样子再解析一遍，脚本必须正好在它自己的结束标签处结束
      if (attributes.src === undefined) {
        const rendered = parseFragment(`<script>${code}</script><br>`).childNodes
        if (rendered.length !== 2 || rendered[1]?.nodeName !== 'br') return invalid('script_code')
      }
      if (attributes.type !== undefined) {
        const value = attributes.type
        attributes.type = value.trim().toLowerCase()
        if (!scriptTypes.has(attributes.type)) return invalid('script_type', { attribute: 'type', value })
      }
      elements.push({ kind: 'script', attributes, code: attributes.src === undefined ? code : '' })
    } else if (tag === 'meta') {
      for (const { name } of node.attrs)
        if (!['name', 'property', 'content'].includes(name)) return invalid('attribute', { attribute: name })
      const name = node.attrs.find((attr) => attr.name === 'name')?.value
      const property = node.attrs.find((attr) => attr.name === 'property')?.value
      const content = node.attrs.find((attr) => attr.name === 'content')?.value
      if (content === undefined || (name === undefined) === (property === undefined)) return invalid('meta')
      const value = name ?? property!
      if (reservedMeta.has(value.toLowerCase()))
        return invalid('meta_reserved', { attribute: name === undefined ? 'property' : 'name', value })
      elements.push({ kind: 'meta', ...(name === undefined ? { property } : { name }), content })
    } else return invalid('tag')
  }
  return { ok: true, elements }
}

export function checkCustomCss(css: string): boolean {
  return !/<\/style/i.test(css)
}
