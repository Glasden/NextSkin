import { requestRoot } from '@nextskin/api'
import { can, hasAdminAccess, type CorePermission } from '@nextskin/domain'
import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import { getServer } from './server'

/** 客户端看到的站点地址。服务端组件里没有 Request，按请求头拼出来 */
export async function getRequestRoot(): Promise<string> {
  return requestRoot(new Request('http://localhost/', { headers: await headers() }))
}

/** 服务端组件里取当前登录用户；没有登录时返回 null。同一次渲染里多处调用（语言解析、页面）只查一次 */
export const getSessionUser = cache(async () => {
  const [headerList, { core }, root] = await Promise.all([headers(), getServer(), getRequestRoot()])
  return core.auth.getSessionUser(headerList, root)
})

/** 用户中心的页面用：没有登录时跳到登录页，登录后回到 path */
export async function requireUser(path: string) {
  const user = await getSessionUser()
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(path)}`)
  return user
}

/**
 * 后台的页面用：没有登录时跳到登录页；没有这项权限（不传时是任何一项后台权限）返回 404（ADR-0027）。
 * 只决定页面显示什么，防线在领域层：查询和用例按数据库里的角色再检查一遍
 */
export async function requireAdmin(path: string, permission?: CorePermission) {
  const user = await requireUser(path)
  if (permission ? !can(user.role, permission) : !hasAdminAccess(user.role)) notFound()
  return user
}

export { safeNextPath } from '@nextskin/api'
