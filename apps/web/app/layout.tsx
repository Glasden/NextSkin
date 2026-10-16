import type { ReactNode } from 'react'
import './globals.css'

export const metadata = { title: 'NextSkin' }

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-dvh bg-bg font-sans text-text">{children}</body>
    </html>
  )
}
