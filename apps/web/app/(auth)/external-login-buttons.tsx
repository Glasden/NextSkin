'use client'

import { Alert, Button } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useEffect, useState, type ReactElement } from 'react'
import { apiError, postJson } from '../../lib/api-client'

export interface ExternalProvider {
  pluginId: string
  providerId: string
  /** 已经按页面的语言翻译好的第三方名称，例如 GitHub */
  name: string
  icon: ReactElement
}

const key = (provider: ExternalProvider) => `${provider.pluginId}/${provider.providerId}`

/**
 * 第三方登录的按钮（ADR-0034）：向接口要第三方授权页的地址，再整页跳过去，state 由接口写进 Cookie。
 * 登录页和注册页共用；还没有账号的人回来以后进"完成注册"页
 */
export function ExternalLoginButtons({
  providers,
  next,
  verb,
}: {
  providers: readonly ExternalProvider[]
  /** 登录后去的站内路径，页面已经检查过 */
  next: string
  verb: 'signIn' | 'signUp'
}) {
  const t = useTranslations('auth.external')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // 从第三方的页面按返回键回来时，浏览器可能直接恢复跳转前的页面，按钮还停在提交中
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setPending(null)
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])

  async function start(provider: ExternalProvider) {
    setPending(key(provider))
    setError(null)
    const { status, data } = await postJson(
      `/api/external-login/${encodeURIComponent(provider.pluginId)}/${encodeURIComponent(provider.providerId)}`,
      { intent: 'signIn', next },
    )
    const url = (data as { url?: unknown } | null)?.url
    if (status === 200 && typeof url === 'string') {
      // 跳转之前按钮一直保持提交中
      window.location.assign(url)
      return
    }
    setError(apiError(data)?.message ?? t('failed', { provider: provider.name }))
    setPending(null)
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Alert tone="danger">{error}</Alert>}
      {providers.map((provider) => (
        <Button
          key={key(provider)}
          size="lg"
          fullWidth
          loading={pending === key(provider)}
          disabled={pending !== null && pending !== key(provider)}
          onClick={() => void start(provider)}
        >
          {provider.icon}
          {t(verb, { provider: provider.name })}
        </Button>
      ))}
    </div>
  )
}
