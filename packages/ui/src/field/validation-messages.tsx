'use client'

import { createContext, useContext, type ReactNode } from 'react'

/**
 * 浏览器约束校验的提示文案。浏览器给的消息跟随浏览器语言，站点是双语的，和页面对不上，
 * 所以由站点按当前语言在根布局给一份，Field 自己不带文案
 */
export interface ValidationMessages {
  /** 没填就提交（required） */
  required: string
  /** 内容格式不对，例如 type="email"、type="url"、pattern 不匹配。Field 拿到具体说法时用具体的 */
  format: string
  /** 比 minLength 短 */
  tooShort: string
  /** 超出 min、max 或 step */
  range: string
}

const ValidationMessagesContext = createContext<ValidationMessages | null>(null)

export interface ValidationMessagesProviderProps {
  messages: ValidationMessages
  children: ReactNode
}

export function ValidationMessagesProvider({ messages, children }: ValidationMessagesProviderProps) {
  return <ValidationMessagesContext.Provider value={messages}>{children}</ValidationMessagesContext.Provider>
}

/** 没有 Provider 时返回 null，Field 退回浏览器的消息 */
export function useValidationMessages(): ValidationMessages | null {
  return useContext(ValidationMessagesContext)
}
