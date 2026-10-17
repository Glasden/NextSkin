'use client'

import { Alert, Button, Field, Form, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, postJson } from '../../../lib/api-client'

type PlayerNameRule = 'official' | 'cjk' | 'utf8' | 'custom'

export interface SignUpFormProps {
  password: { min: number; max: number }
  /** 注册时填写角色名（auth.registration.withPlayerName）；关闭时填昵称 */
  playerName: { rule: PlayerNameRule; min: number; max: number } | null
  /** 配置了邮件发送：注册后会发验证邮件 */
  verificationNotice: boolean
}

// 浏览器先按角色名规则拦一道，提示看说明文字；自定义规则是管理员写的正则，只由服务端检查。
// pattern 按 v 标志解析，匹配整个值
const playerNamePatterns: Record<PlayerNameRule, string | undefined> = {
  official: '[A-Za-z0-9_]+',
  cjk: '[A-Za-z0-9_§\\u4e00-\\u9fff]+',
  utf8: '\\S+',
  custom: undefined,
}

export function SignUpForm({ password, playerName, verificationNotice }: SignUpFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function submit(values: Record<string, string | undefined>) {
    setPending(true)
    setError(null)
    setErrors({})
    const { status, data } = await postJson('/api/register', values)
    if (status === 201) {
      // 会话没建成（极少见）时去登录页，账号已经注册好了
      const signedIn = (data as { signedIn?: unknown } | null)?.signedIn === true
      router.replace(signedIn ? '/' : '/sign-in')
      router.refresh()
      return
    }
    const failure = apiError(data)
    if (failure?.fields) setErrors(formErrors(failure))
    else setError(failure?.message ?? t('signUp.failed'))
    setPending(false)
  }

  return (
    <Form errors={errors} onFormSubmit={(values) => void submit(values)}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field
        label={t('email')}
        name="email"
        description={verificationNotice ? t('signUp.verificationNotice') : undefined}
      >
        <Input type="email" autoComplete="email" required />
      </Field>
      <Field label={t('password')} name="password" description={t('signUp.passwordHint', password)}>
        <Input type="password" autoComplete="new-password" required minLength={password.min} maxLength={password.max} />
      </Field>
      {playerName ? (
        <Field label={t('signUp.playerName')} name="playerName" description={t('signUp.playerNameHint', playerName)}>
          <Input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={playerName.min}
            maxLength={playerName.max}
            pattern={playerNamePatterns[playerName.rule]}
          />
        </Field>
      ) : (
        <Field label={t('signUp.nickname')} name="nickname" description={t('signUp.nicknameHint')}>
          <Input autoComplete="nickname" required maxLength={255} />
        </Field>
      )}
      <div className="mt-2">
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
          {t('signUp.submit')}
        </Button>
      </div>
    </Form>
  )
}
