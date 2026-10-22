'use client'

import { CSPProvider } from '@base-ui/react/csp-provider'
import type { ReactNode } from 'react'

export interface CspProviderProps {
  /** 本次请求的 nonce（ADR-0053），由根布局从请求头读出 */
  nonce: string | undefined
  children: ReactNode
}

/** 把页面 CSP 的 nonce 交给 Base UI：Tabs 在水合前插的内联脚本、Select 弹层插的 <style> 由它带上 nonce */
export function CspProvider({ nonce, children }: CspProviderProps) {
  return <CSPProvider nonce={nonce}>{children}</CSPProvider>
}
