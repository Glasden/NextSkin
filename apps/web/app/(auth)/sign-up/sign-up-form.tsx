'use client'

import { Alert, Button, Field, Form, Input } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { apiError, formErrors, postJson } from '../../../lib/api-client'
import { playerNameInputProps, type PlayerNameRules } from '../../../lib/player-name'
import { initialFieldValue, PluginField, type PluginFieldValue } from '../../_plugins/plugin-field'
import type { PluginFieldText } from '../../_plugins/types'

export interface SignUpFormProps {
  password: { min: number; max: number }
  /** 注册时填写角色名（auth.registration.withPlayerName）；关闭时填昵称 */
  playerName: PlayerNameRules | null
  /** 配置了邮件发送：注册后会发验证邮件 */
  verificationNotice: boolean
  /** 插件加的字段（ADR-0033）：值按插件 id 分组提交，出错的字段名是 `<插件 id>.<字段名>` */
  pluginFields: readonly { pluginId: string; field: PluginFieldText }[]
}

export function SignUpForm({ password, playerName, verificationNotice, pluginFields }: SignUpFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [extra, setExtra] = useState<Record<string, PluginFieldValue>>(() =>
    Object.fromEntries(
      pluginFields.map(({ pluginId, field }) => [`${pluginId}.${field.name}`, initialFieldValue(field)]),
    ),
  )

  async function submit(values: Record<string, string | undefined>) {
    setPending(true)
    setError(null)
    setErrors({})
    const plugins: Record<string, Record<string, PluginFieldValue>> = {}
    for (const { pluginId, field } of pluginFields)
      (plugins[pluginId] ??= {})[field.name] = extra[`${pluginId}.${field.name}`] ?? ''
    const { status, data } = await postJson('/api/register', {
      email: values.email,
      password: values.password,
      nickname: values.nickname,
      playerName: values.playerName,
      ...(pluginFields.length ? { plugins } : {}),
    })
    if (status === 201) {
      // 会话没建成（极少见）时去登录页，账号已经注册好了
      const signedIn = (data as { signedIn?: unknown } | null)?.signedIn === true
      router.replace(signedIn ? '/user' : '/sign-in')
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
          <Input {...playerNameInputProps(playerName)} autoComplete="username" />
        </Field>
      ) : (
        <Field label={t('signUp.nickname')} name="nickname" description={t('signUp.nicknameHint')}>
          <Input autoComplete="nickname" required maxLength={255} />
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
      <div className="mt-2">
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending}>
          {t('signUp.submit')}
        </Button>
      </div>
    </Form>
  )
}
