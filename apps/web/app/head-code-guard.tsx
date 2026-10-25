'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { announceSessionChange } from '../lib/session-change'

// 这个文档有没有运行过页头代码。脚本一旦跑起来就卸不掉，所以只设不清；客户端跳转和 router.refresh() 都不重新加载模块
let ranHeadCode = false

/**
 * 有管理权限的用户的页面不运行页头代码（ADR-0063）。登录和退出已经是整页跳转，别的标签页由页头代码前面的内联脚本处理
 * （lib/session-change.ts），这里补上：
 * - 有管理权限的用户打开页面时通知别的标签页：第三方登录插件的回调、在线提升身份以后整页打开的页面，都不经过 goToNext；
 * - 同一个文档：根布局重新渲染时用户已经有管理权限（在线提升身份后 router.refresh()），或者客户端跳进了后台。
 *
 * 每一页都渲染，和设没设页头代码无关：清空页头代码之前就开着的标签页，脚本还在跑。
 * `loaded`：这次渲染输出了页头代码；`admin`：当前用户有管理权限
 */
export function HeadCodeGuard({ loaded, admin }: { readonly loaded: boolean; readonly admin: boolean }) {
  const pathname = usePathname()
  const previous = useRef<string | null>(null)

  useEffect(() => {
    if (loaded) ranHeadCode = true
    else if (admin && ranHeadCode) window.location.reload()
  }, [loaded, admin])

  useEffect(() => {
    if (admin) announceSessionChange()
  }, [admin])

  // 只看路径变了的客户端跳转：直接打开的后台页面已经按身份渲染过；没有权限的人打开 /admin 得到 404 页，照常带页头代码，
  // 重新加载会没完没了（开发模式下 effect 跑两遍，第二遍的路径没变）
  useEffect(() => {
    const navigated = previous.current !== null && previous.current !== pathname
    previous.current = pathname
    if (navigated && ranHeadCode && (pathname === '/admin' || pathname.startsWith('/admin/'))) window.location.reload()
  }, [pathname])

  return null
}
