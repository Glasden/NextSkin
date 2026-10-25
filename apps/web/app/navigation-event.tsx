'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'

/** 给站长的约定（ADR-0063），改名或改 detail 的结构要和协议一样小心：站长贴的代码不会跟着升级 */
const NAVIGATE_EVENT = 'nextskin:navigate'

/**
 * 客户端跳转完成后在 window 上派发 nextskin:navigate，detail.path 是路径加查询串、不带 #。
 * 百度统计这类只记第一次打开的页面的服务，靠它记客户端跳转后的浏览。第一次打开和 router.refresh() 不派发：
 * 只在路径或查询串变了时派发，开发模式下 effect 跑两遍也不会多派一次
 */
export function NavigationEvent() {
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const key = `${pathname}?${search}`
  const previous = useRef(key)
  useEffect(() => {
    if (previous.current === key) return
    previous.current = key
    // 取浏览器地址栏里的写法，不用 URLSearchParams 重新编码过的
    const path = window.location.pathname + window.location.search
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { path } }))
  }, [key])
  return null
}
