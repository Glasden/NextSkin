'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { Button } from '@nextskin/ui'

/** 宿主自己的交互：用来确认插件出错时宿主仍然可用 */
export function HostChrome({ children }: { readonly children: ReactNode }) {
  const router = useRouter()
  const [count, setCount] = useState(0)
  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b-2 border-border bg-surface px-6 py-3">
        <strong className="mr-auto">NextSkin S3</strong>
        <Link href="/" className="text-sm underline">首页</Link>
        <Link href="/other" className="text-sm underline" data-testid="nav-other">另一页</Link>
        <Link href="/csp-probe" className="text-sm underline">CSP 探测</Link>
        <Button data-testid="host-count" onClick={() => setCount((c) => c + 1)}>宿主计数 {count}</Button>
        <Button data-testid="host-refresh" onClick={() => router.refresh()}>刷新数据</Button>
        <Button
          data-testid="theme-toggle"
          onClick={() => {
            const root = document.documentElement
            root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'
          }}
        >
          切换主题
        </Button>
      </header>
      <main className="mx-auto grid max-w-3xl gap-6 p-6">{children}</main>
    </>
  )
}
