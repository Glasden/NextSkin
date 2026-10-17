import { requestRoot } from '@nextskin/api'
import { headers } from 'next/headers'
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
