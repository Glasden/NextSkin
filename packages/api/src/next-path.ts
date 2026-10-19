/**
 * 登录后要去的站内路径。只接受以单个 / 开头的路径：`//evil.test`、`/\evil.test` 会被浏览器当成别的网站；
 * 浏览器解析地址时会删掉制表符和换行，`/\t/evil.test` 也一样，所以控制字符和反斜杠一律不收。
 * 登录页和第三方登录的接口共用
 */
export function safeNextPath(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- 就是要排除控制字符
  return typeof value === 'string' && /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/.test(value) ? value : '/user'
}
