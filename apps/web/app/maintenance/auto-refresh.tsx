'use client'

import { useEffect } from 'react'

/** 维护期间每 30 秒刷新一次（与 503 的 Retry-After 相同）：导入结束后，原来的地址就回到原来的页面 */
export function AutoRefresh() {
  useEffect(() => {
    const timer = setTimeout(() => window.location.reload(), 30_000)
    return () => clearTimeout(timer)
  }, [])
  return null
}
