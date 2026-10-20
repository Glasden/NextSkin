'use client'

import { CaptchaFrame } from '@nextskin/ui'
import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/** 页面的服务端组件从 `core.captcha.publicConfig()` 读到的配置；没启用时是 null（ADR-0038） */
export interface CaptchaConfig {
  provider: 'turnstile' | 'hcaptcha' | 'recaptcha'
  siteKey: string
  /** 隐形 reCAPTCHA：不占位置，提交时执行 */
  invisible: boolean
}

/** 三个入口都从这个请求头取令牌（ADR-0038"核对"） */
export const CAPTCHA_HEADER = 'X-Captcha-Response'

/** 服务端核对验证码的三种失败，页面按 code 显示文案 */
export const CAPTCHA_ERROR_CODES = ['captcha_required', 'captcha_failed', 'captcha_unavailable'] as const
export type CaptchaErrorCode = (typeof CAPTCHA_ERROR_CODES)[number]

export function isCaptchaError(code: string | null | undefined): code is CaptchaErrorCode {
  return (CAPTCHA_ERROR_CODES as readonly (string | null | undefined)[]).includes(code)
}

type WidgetId = string | number

/** 三家显式渲染的接口只有这几个函数，参数名各不相同，由下面的 adapters 抹平 */
interface WidgetApi {
  render(element: HTMLElement, options: Record<string, unknown>): WidgetId
  reset(id: WidgetId): void
  execute?(id: WidgetId): void
  remove?(id: WidgetId): void
}

interface Adapter {
  /** 加载失败时告诉用户要能访问哪一家、哪个域名 */
  name: string
  host: string
  script(onload: string, locale: string): string
  api(): WidgetApi | undefined
  options(input: { locale: string; theme: 'light' | 'dark'; invisible: boolean }): Record<string, unknown>
}

declare global {
  interface Window {
    turnstile?: WidgetApi
    hcaptcha?: WidgetApi
    grecaptcha?: WidgetApi
  }
}

// 脚本都用显式渲染，加载完成时调用 onload 指定的全局函数：reCAPTCHA 的 api.js 还要再拉一个脚本，
// 只等 script 元素的 load 事件，render 可能还不存在
const adapters: Record<CaptchaConfig['provider'], Adapter> = {
  turnstile: {
    name: 'Cloudflare Turnstile',
    host: 'challenges.cloudflare.com',
    script: (onload) => `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=${onload}`,
    api: () => window.turnstile,
    options: ({ locale, theme }) => ({ theme, language: locale.toLowerCase() }),
  },
  hcaptcha: {
    name: 'hCaptcha',
    host: 'hcaptcha.com',
    // recaptchacompat=off：不在 window 上冒充 grecaptcha
    script: (onload) => `https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off&onload=${onload}`,
    api: () => window.hcaptcha,
    options: ({ locale, theme }) => ({ theme, hl: locale }),
  },
  // 走 www.recaptcha.net：访问不了 www.google.com 的地方也能用，服务端的核对也是它（ADR-0038）
  recaptcha: {
    name: 'Google reCAPTCHA',
    host: 'www.recaptcha.net',
    script: (onload, locale) =>
      `https://www.recaptcha.net/recaptcha/api.js?render=explicit&onload=${onload}&hl=${encodeURIComponent(locale)}`,
    api: () => window.grecaptcha,
    // 隐形挂件的标志放进表单里，不浮在页面右下角
    options: ({ theme, invisible }) => (invisible ? { size: 'invisible', badge: 'inline' } : { theme }),
  },
}

/** 每家的脚本只加载一次；失败时丢掉，重试时重新加载 */
const scripts = new Map<CaptchaConfig['provider'], Promise<WidgetApi>>()

/** 脚本迟迟不到（被拦截却没有报错）时也当作失败，给用户重试的机会 */
const SCRIPT_TIMEOUT_MS = 15_000

function loadScript(provider: CaptchaConfig['provider'], locale: string): Promise<WidgetApi> {
  const cached = scripts.get(provider)
  if (cached) return cached
  const adapter = adapters[provider]
  const promise = new Promise<WidgetApi>((resolve, reject) => {
    const callback = `nextskinCaptchaLoaded_${provider}`
    const script = document.createElement('script')
    const globals = window as unknown as Record<string, unknown>
    const fail = () => {
      clearTimeout(timer)
      delete globals[callback]
      script.remove()
      scripts.delete(provider)
      reject(new Error('captcha_script_failed'))
    }
    const timer = setTimeout(fail, SCRIPT_TIMEOUT_MS)
    globals[callback] = () => {
      clearTimeout(timer)
      delete globals[callback]
      const api = adapter.api()
      if (api) resolve(api)
      else fail()
    }
    script.src = adapter.script(callback, locale)
    script.async = true
    script.onerror = fail
    document.head.append(script)
  })
  scripts.set(provider, promise)
  return promise
}

export interface Captcha {
  /** 放在提交按钮上方的挂件；没启用时是 null */
  element: ReactNode
  /**
   * 当前的令牌。隐形 reCAPTCHA 在这里执行，可能弹出挑战，等用户完成才返回；出错时返回 null，用户关掉挑战时一直不返回，
   * 所以要在把按钮设成提交中之前调用。没启用时返回 null，请求不带请求头
   */
  getToken(): Promise<string | null>
  /** 每次提交之后调用，不论成败：令牌只能核对一次（ADR-0038"页面"） */
  reset(): void
}

/** 登录、注册、找回密码和后台的测试共用：渲染挂件，交出令牌 */
export function useCaptcha(config: CaptchaConfig | null): Captcha {
  const t = useTranslations('captcha')
  const locale = useLocale()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const widget = useRef<{ api: WidgetApi; id: WidgetId } | null>(null)
  const token = useRef<string | null>(null)
  const waiting = useRef<((value: string | null) => void) | null>(null)
  const provider = config?.provider
  const siteKey = config?.siteKey
  const invisible = config?.invisible ?? false

  useEffect(() => {
    const host = container.current
    if (!provider || !siteKey || !host) return
    let cancelled = false
    loadScript(provider, locale).then(
      (api) => {
        if (cancelled) return
        // 每次渲染进一个新元素：reCAPTCHA 不能在同一个元素上渲染两次
        const target = document.createElement('div')
        host.replaceChildren(target)
        const theme = host.closest('[data-theme="dark"]') ? 'dark' : 'light'
        const id = api.render(target, {
          sitekey: siteKey,
          ...adapters[provider].options({ locale, theme, invisible }),
          callback: (value: string) => {
            token.current = value
            waiting.current?.(value)
            waiting.current = null
          },
          'expired-callback': () => {
            token.current = null
          },
          'error-callback': () => {
            token.current = null
            waiting.current?.(null)
            waiting.current = null
            // 隐形 reCAPTCHA 出错（多半是网络）时页面上什么都看不到，要应用自己提示重试；
            // 看得见的挂件自己显示错误、自己重试，不能把它藏起来
            if (invisible) setStatus('error')
          },
        })
        widget.current = { api, id }
        setStatus('ready')
      },
      () => {
        if (!cancelled) setStatus('error')
      },
    )
    return () => {
      cancelled = true
      const current = widget.current
      widget.current = null
      token.current = null
      waiting.current = null
      // reCAPTCHA 没有 remove：元素随容器一起清掉
      if (current) current.api.remove?.(current.id)
      host.replaceChildren()
    }
  }, [provider, siteKey, invisible, locale, attempt])

  const getToken = useCallback(async (): Promise<string | null> => {
    if (!provider) return null
    const current = widget.current
    if (!current) return null
    if (token.current || !invisible || !current.api.execute) return token.current
    return new Promise<string | null>((resolve) => {
      waiting.current = resolve
      current.api.execute?.(current.id)
    })
  }, [provider, invisible])

  const reset = useCallback(() => {
    token.current = null
    waiting.current = null
    const current = widget.current
    if (current) current.api.reset(current.id)
  }, [])

  const adapter = provider ? adapters[provider] : null
  const element = adapter ? (
    <CaptchaFrame
      status={status}
      label={t('label')}
      loadingText={t('loading')}
      error={t('loadFailed', { provider: adapter.name, host: adapter.host })}
      retryLabel={t('retry')}
      onRetry={() => {
        setStatus('loading')
        setAttempt((count) => count + 1)
      }}
    >
      <div ref={container} />
    </CaptchaFrame>
  ) : null

  return { element, getToken, reset }
}
