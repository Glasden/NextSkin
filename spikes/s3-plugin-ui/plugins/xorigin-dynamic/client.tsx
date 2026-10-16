/**
 * 探测：插件代码在主域运行时，CSP 还能挡住哪些事。结果写在 data-* 上，由测试读取。
 * 这些行为插件都"不应该"做；这里要弄清的是 CSP 能不能把它们挡住，从而决定文档里能承诺什么。
 */
import { useEffect, useState } from 'react'

const ORIGIN = 'http://127.0.0.1:3301'
type Outcome = 'pending' | 'ok' | 'blocked'

function waitForFlag(flag: string, ms: number): Promise<boolean> {
  const g = globalThis as Record<string, unknown>
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => (g[flag] === true ? resolve(true) : Date.now() - started > ms ? resolve(false) : setTimeout(tick, 50))
    tick()
  })
}

function injectScript(src: string, flag: string, nonce: string | null): Promise<Outcome> {
  const script = document.createElement('script')
  script.src = src
  if (nonce !== null) script.nonce = nonce
  document.head.append(script)
  return waitForFlag(flag, 2000).then((ran) => (ran ? 'ok' : 'blocked'))
}

export default function XoriginDynamic() {
  const [results, setResults] = useState<Record<string, Outcome>>({})
  useEffect(() => {
    const set = (key: string, value: Outcome) => setResults((r) => ({ ...r, [key]: value }))
    const imp = (url: string) => import(/* webpackIgnore: true */ url)
    void imp(`${ORIGIN}/dynamic.js`).then(() => set('dynamicImport', 'ok'), () => set('dynamicImport', 'blocked'))
    void injectScript(`${ORIGIN}/inject.js`, '__s3_inject', null).then((o) => set('scriptNoNonce', o))
    // 浏览器会把 nonce 属性藏起来，但 HTMLElement.nonce 属性仍可读
    const nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce ?? ''
    void injectScript(`${ORIGIN}/inject-nonce.js`, '__s3_inject_nonce', nonce).then((o) => set('scriptWithNonce', o))
    void fetch(`${ORIGIN}/fetch`).then(() => set('fetch', 'ok'), () => set('fetch', 'blocked'))
    const img = new Image()
    img.onload = () => set('image', 'ok')
    img.onerror = () => set('image', 'blocked')
    img.src = `${ORIGIN}/img.gif`
    set('nonceReadable', nonce.length > 0 ? 'ok' : 'blocked')
  }, [])
  const attrs = Object.fromEntries(Object.entries(results).map(([k, v]) => [`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v]))
  return (
    <pre data-testid="xorigin-dynamic" data-done={String(Object.keys(results).length === 6)} {...attrs}>
      {JSON.stringify(results, null, 2)}
    </pre>
  )
}
