'use client'

import { Alert, Button, Field, Form, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, sendJson } from '../../../lib/api-client'
import { CAPTCHA_HEADER, useCaptcha, type CaptchaConfig } from '../../../lib/captcha'
import { goToNext } from '../../../lib/navigation'
import { playerNameInputProps, type PlayerNameRules } from '../../../lib/player-name'
import { initialFieldValue, PluginField, type PluginFieldValue } from '../../_plugins/plugin-field'
import type { PluginFieldText } from '../../_plugins/types'

/** "完成注册"页（ADR-0034）：第三方给的身份暂存在服务端，表单不填密码 */
export interface ExternalSignUp {
  /** 第三方的名称，例如 GitHub */
  provider: string
  email: string | null
  /** 第三方确认过这个邮箱：不改的话注册后就是已验证的 */
  emailVerified: boolean
  nickname: string | null
  playerName: string | null
  next: string
}

export interface SignUpFormProps {
  password: { min: number; max: number }
  /** 注册时填写角色名（auth.registration.withPlayerName）；关闭时填昵称 */
  playerName: PlayerNameRules | null
  /** 配置了邮件发送：注册后会发验证邮件 */
  verificationNotice: boolean
  /** 插件加的字段（ADR-0033）：值按插件 id 分组提交，出错的字段名是 `<插件 id>.<字段名>` */
  pluginFields: readonly { pluginId: string; field: PluginFieldText }[]
  /** 插件字段的初始值，键是 `<插件 id>.<字段名>`：注册页从地址栏预填的（ADR-0041） */
  prefill?: Readonly<Record<string, string>>
  /** 注册后去的站内路径（页面检查过）；第三方登录的"完成注册"用 external.next */
  next?: string
  external?: ExternalSignUp
  /** 启用了验证码时注册要过（ADR-0038）；第三方登录的"完成注册"不要，不传 */
  captcha?: CaptchaConfig | null
}

export function SignUpForm({
  password,
  playerName,
  verificationNotice,
  pluginFields,
  prefill,
  next = '/user',
  external,
  captcha: captchaConfig = null,
}: SignUpFormProps) {
  const t = useTranslations('auth')
  const errorText = useTranslations('errors')
  const common = useTranslations('common')
  const captcha = useCaptcha(captchaConfig)
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [extra, setExtra] = useState<Record<string, PluginFieldValue>>(() =>
    Object.fromEntries(
      pluginFields.map(({ pluginId, field }) => {
        const key = `${pluginId}.${field.name}`
        return [key, initialFieldValue(field, prefill?.[key])]
      }),
    ),
  )

  function emailHint() {
    if (!external) return verificationNotice ? t('signUp.verificationNotice') : undefined
    if (external.email === null) return t('complete.emailMissing', { provider: external.provider })
    if (external.emailVerified)
      return t(verificationNotice ? 'complete.emailVerified' : 'complete.emailVerifiedNoMail', {
        provider: external.provider,
      })
    return verificationNotice ? t('signUp.verificationNotice') : undefined
  }

  async function submit(values: Record<string, string | undefined>) {
    setError(null)
    setErrors({})
    // 隐形 reCAPTCHA 可能弹出挑战、用户也可能关掉它，所以先拿令牌，再把按钮设成提交中
    const token = await captcha.getToken()
    if (captchaConfig && !token) {
      setError(errorText('captcha_required'))
      return
    }
    setPending(true)
    const plugins: Record<string, Record<string, PluginFieldValue>> = {}
    for (const { pluginId, field } of pluginFields)
      (plugins[pluginId] ??= {})[field.name] = extra[`${pluginId}.${field.name}`] ?? ''
    const { status, data } = await sendJson(
      'POST',
      external ? '/api/external-login/complete' : '/api/register',
      {
        email: values.email,
        ...(external ? {} : { password: values.password }),
        nickname: values.nickname,
        playerName: values.playerName,
        ...(pluginFields.length ? { plugins } : {}),
      },
      { headers: token ? { [CAPTCHA_HEADER]: token } : {} },
    )
    captcha.reset()
    if (status === 201) {
      // 会话没建成（极少见）时去登录页，账号已经注册好了
      const signedIn = (data as { signedIn?: unknown } | null)?.signedIn === true
      const target = external?.next ?? next
      goToNext(router, signedIn ? target : `/sign-in?next=${encodeURIComponent(target)}`)
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
      <Field label={t('email')} name="email" description={emailHint()} formatError={common('emailFormat')}>
        <Input type="email" autoComplete="email" required defaultValue={external?.email ?? undefined} />
      </Field>
      {!external && (
        <Field label={t('password')} name="password" description={t('signUp.passwordHint', password)}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={password.min}
            maxLength={password.max}
          />
        </Field>
      )}
      {playerName ? (
        <Field label={t('signUp.playerName')} name="playerName" description={t('signUp.playerNameHint', playerName)}>
          <Input
            {...playerNameInputProps(playerName)}
            autoComplete="username"
            defaultValue={external?.playerName ?? undefined}
          />
        </Field>
      ) : (
        <Field label={t('signUp.nickname')} name="nickname" description={t('signUp.nicknameHint')}>
          <Input autoComplete="nickname" required maxLength={255} defaultValue={external?.nickname ?? undefined} />
        </Field>
      )}
      {pluginFields.map(({ pluginId, field }) => {
        const name = `${pluginId}.${field.name}`
        return (
          <PluginField
            key={name}
            field={field}
            name={name}
            value={extra[name] ?? ''}
            error={field.type === 'boolean' ? errors[name] : undefined}
            onChange={(value) => setExtra((current) => ({ ...current, [name]: value }))}
          />
        )
      })}
      {captcha.element}
      <div className="mt-2">
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
          {external ? t('complete.submit') : t('signUp.submit')}
        </Button>
      </div>
    </Form>
  )
}
