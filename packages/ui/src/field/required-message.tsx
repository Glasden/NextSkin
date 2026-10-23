'use client'

import { createContext, useContext, type ReactNode } from 'react'

const RequiredMessageContext = createContext<string | null>(null)

export interface RequiredMessageProviderProps {
  /** 控件没填就提交时的提示，例如“请填写这一项。”。跟随站点语言，而不是浏览器语言 */
  message: string
  children: ReactNode
}

/**
 * 给下面的 Field 定下“没填”时的提示。放在根布局里按站点语言传一次，所有表单都不用管：
 * 浏览器给的 required 消息跟随浏览器语言，站点是双语，可能和页面对不上
 */
export function RequiredMessageProvider({ message, children }: RequiredMessageProviderProps) {
  return <RequiredMessageContext.Provider value={message}>{children}</RequiredMessageContext.Provider>
}

/** Field 用：没有 Provider 时返回 null，退回浏览器给的消息 */
export function useRequiredMessage(): string | null {
  return useContext(RequiredMessageContext)
}
