'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'

const CHANNEL = 'nextskin:custom-head'

// 这个文档有没有运行过页头代码。脚本一旦跑起来就卸不掉，所以只设不清；客户端跳转和 router.refresh() 都不重新加载模块
let ranHeadCode = false

/**
 * 有管理权限的用户的页面不运行页头代码（ADR-0063）。登录和退出已经是整页跳转，这里补上另外几种情况：
 * - Cookie 是整个浏览器共用的：访客的标签页里跑着页头代码，在另一个标签页登录成管理员以后，旧标签页的脚本带着管理员的会话。
 *   管理员的页面打开时广播一声，运行过页头代码的标签页收到就整页重新加载；
 * - 同一个文档：根布局重新渲染时用户已经是管理员（在线提升身份后 router.refresh()），或者客户端跳进了后台。
 *
 * 只在设了页头代码时渲染。`loaded`：这次渲染输出了页头代码；`admin`：当前用户有管理权限
 */
export function HeadCodeGuard({ loaded, admin }: { readonly loaded: boolean; readonly admin: boolean }) {
  const pathname = usePathname()
  const previous = useRef<string | null>(null)

  useEffect(() => {
    if (loaded) ranHeadCode = true
    else if (admin && ranHeadCode) window.location.reload()
  }, [loaded, admin])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = () => {
      if (ranHeadCode) window.location.reload()
    }
    if (admin) channel.postMessage('admin')
    return () => channel.close()
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
