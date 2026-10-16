import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { HostChrome } from '@/src/host/host-chrome'
import { importMapFor, serializeForScript } from '@/src/host/import-map'
import { sriMode } from '@/src/host/registry'
import './globals.css'

export const metadata = { title: 'NextSkin S3' }

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined
  const importMap = await importMapFor(await sriMode())
  return (
    <html lang="zh-CN" data-theme="light">
      <head>
        {/* 必须排在任何模块脚本和 modulepreload 之前 */}
        <script type="importmap" nonce={nonce} dangerouslySetInnerHTML={{ __html: serializeForScript(importMap) }} />
      </head>
      <body className="min-h-dvh bg-bg text-text">
        <CSPProvider nonce={nonce}>
          <HostChrome>{children}</HostChrome>
        </CSPProvider>
      </body>
    </html>
  )
}
