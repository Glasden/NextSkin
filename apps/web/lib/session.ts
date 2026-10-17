import { requestRoot } from '@nextskin/api'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { getServer } from './server'

/**
 * 服务端组件里取当前登录用户；没有登录时返回 null。同一次渲染里多处调用（语言解析、页面）只查一次。
 * getSessionUser 要客户端看到的站点地址，服务端组件里没有 Request，按请求头拼出来
 */
export const getSessionUser = cache(async () => {
  const [headerList, { core }] = await Promise.all([headers(), getServer()])
  return core.auth.getSessionUser(headerList, requestRoot(new Request('http://localhost/', { headers: headerList })))
})

/** 用户中心的页面用：没有登录时跳到登录页，登录后回到 path */
export async function requireUser(path: string) {
  const user = await getSessionUser()
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(path)}`)
  return user
}

/**
 * 登录后要去的站内路径。只接受以单个 / 开头的路径：`//evil.test`、`/\evil.test` 会被浏览器当成别的网站；
 * 浏览器解析地址时会删掉制表符和换行，`/\t/evil.test` 也一样，所以控制字符和反斜杠一律不收
 */
export function safeNextPath(value: string | string[] | undefined): string {
  // eslint-disable-next-line no-control-regex -- 就是要排除控制字符
  return typeof value === 'string' && /^\/(?!\/)[^\\\u0000-\u001f\u007f]*$/.test(value) ? value : '/user'
}
