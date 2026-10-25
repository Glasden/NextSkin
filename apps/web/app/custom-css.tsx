'use client'

import { usePathname } from 'next/navigation'

/**
 * 自定义 CSS（ADR-0063），放在 <body> 的开头：排在主题的样式后面，不进 layer，压得过 Tailwind 的工具类。
 * 后台不套用：客户端跳进后台时 React 卸下这个 <style>，写坏的 CSS 挡不住改回来的地方。
 * 保存时拒绝了 </style，内容结束不了这个标签
 */
export function CustomCss({ css }: { readonly css: string }) {
  const pathname = usePathname()
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return null
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
