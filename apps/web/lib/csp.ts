/**
 * 页面的内容安全策略（ADR-0053）：只执行带本次请求 nonce 的脚本和由它们加载的脚本（'strict-dynamic'），不列来源。
 * 样式、图片、请求、iframe 不约束：Markdown 允许外站图片、服务端渲染的 style 属性离不开 'unsafe-inline'，白名单挡不住什么
 */

/** proxy.ts 把 nonce 放进这个请求头，根布局从这里读 */
export const NONCE_HEADER = 'x-nonce'

/** 16 字节随机数的 base64，每个页面请求一个 */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/** 开发模式多一个 'unsafe-eval'：React 在开发模式里用 eval 还原服务端的错误堆栈 */
export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
