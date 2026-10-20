import { Link } from '@nextskin/ui'
import NextLink from 'next/link'
import type { ReactNode } from 'react'

/**
 * 认证页之间带着 next 的链接（登录、注册、重新登录）。next 是回到授权流程的 `/api/…` 地址时用普通链接整页导航：
 * 那边的页面已经登录时会 redirect(next)，客户端路由下这一步先发 RSC 的 fetch，授权要跑两遍（ADR-0037"登录后续跑"）
 */
export function AuthLink({
  href,
  next,
  children,
}: {
  readonly href: string
  readonly next: string
  readonly children: ReactNode
}) {
  return next.startsWith('/api/') ? (
    <Link href={href}>{children}</Link>
  ) : (
    <Link render={<NextLink href={href} />}>{children}</Link>
  )
}
