/** 探测：插件模块静态 import 其他源的脚本，CSP 会不会拦 */
// @ts-expect-error 远程模块没有类型
import 'http://127.0.0.1:3301/static.js'

export default function XoriginStatic() {
  return <p data-testid="xorigin-static" data-ran={String((globalThis as Record<string, unknown>).__s3_static === true)}>static import 已执行</p>
}
