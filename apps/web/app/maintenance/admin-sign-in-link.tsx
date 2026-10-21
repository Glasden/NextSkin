'use client'

import { Link } from '@nextskin/ui'
import NextLink from 'next/link'
import { useSyncExternalStore, type ReactNode } from 'react'

const subscribe = () => () => {}

function signInHref(): string {
  const { pathname, search } = window.location
  return pathname === '/maintenance' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(pathname + search)}`
}

/**
 * 维护页是 proxy 换上来的（ADR-0044），浏览器的地址还是原来要打开的页面，服务端渲染时拿不到它：
 * 到了浏览器里再把它带给登录页，管理员登录后回到那里。直接打开 /maintenance 的，登录后照常去用户中心
 */
export function AdminSignInLink({ children }: { children: ReactNode }) {
  const href = useSyncExternalStore(subscribe, signInHref, () => '/sign-in')
  return <Link render={<NextLink href={href} />}>{children}</Link>
}
