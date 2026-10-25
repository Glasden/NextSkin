'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useRef } from 'react'

/** 给站长的约定（ADR-0063），改名或改 detail 的结构要和协议一样小心：站长贴的代码不会跟着升级 */
const NAVIGATE_EVENT = 'nextskin:navigate'

/**
 * 客户端跳转完成后在 window 上派发 nextskin:navigate，detail.path 是路径加查询串、不带 #。
 * 百度统计这类只记第一次打开的页面的服务，靠它记客户端跳转后的浏览。第一次打开和 router.refresh() 不派发：
 * 只在地址栏里的路径或查询串变了时派发，开发模式下 effect 跑两遍也不会多派一次
 */
export function NavigationEvent() {
  const pathname = usePathname()
  // 按对象比较：Next 按地址的原样写法重建它，`?q=a%20b` 跳到 `?q=a+b` 也会变；toString() 会把两者归一成同一个
  const searchParams = useSearchParams()
  const previous = useRef<string | null>(null)
  useEffect(() => {
    const path = window.location.pathname + window.location.search
    if (previous.current === null || previous.current === path) {
      previous.current = path
      return
    }
    previous.current = path
    window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { path } }))
  }, [pathname, searchParams])
  return null
}
