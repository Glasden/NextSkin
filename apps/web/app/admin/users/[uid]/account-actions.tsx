'use client'

import { Button, Field, Input, Select } from '@nextskin/ui'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { postJson, sendJson } from '../../../../lib/api-client'
import { ActionDialog } from './action-dialog'

interface Target {
  uid: number
  nickname: string
  email: string
}

/** 改昵称：规则同注册，去掉首尾空白后 1 到 255 个字符（ADR-0018） */
export function NicknameDialog({ user }: { user: Target }) {
  const t = useTranslations('admin.userDetail.account')
  return (
    <ActionDialog
      id="admin-nickname"
      fields={['nickname']}
      trigger={<Button size="sm">{t('nickname')}</Button>}
      title={t('nicknameTitle', { nickname: user.nickname })}
      description={t('nicknameHint')}
      confirm={t('nicknameConfirm')}
      send={(values) => sendJson('PATCH', `/api/admin/users/${user.uid}`, { nickname: values.nickname })}
      done={(data) => t('nicknameDone', { nickname: (data as { nickname: string }).nickname })}
    >
      <Field label={t('nicknameLabel')} name="nickname">
        <Input defaultValue={user.nickname} maxLength={255} required autoComplete="off" />
      </Field>
    </ActionDialog>
  )
}

/**
 * 改邮箱（ADR-0036"改邮箱"）：配置了邮件时给新地址发确认链接，确认之后才生效；没有配置邮件时立即生效，
 * 新地址算不算已验证要管理员明确选一项，不预选
 */
export function EmailDialog({
  user,
  mailConfigured,
  requireVerification,
}: {
  user: Target
  mailConfigured: boolean
  requireVerification: boolean
}) {
  const t = useTranslations('admin.userDetail.account')
  const [verified, setVerified] = useState<'verified' | 'unverified' | undefined>(undefined)
  return (
    <ActionDialog
      id="admin-email"
      fields={['email', 'verified']}
      onOpen={() => setVerified(undefined)}
      trigger={<Button size="sm">{t('email')}</Button>}
      title={t('emailTitle', { nickname: user.nickname })}
      description={mailConfigured ? t('emailHintMail') : t('emailHintNoMail')}
      confirm={mailConfigured ? t('emailConfirmMail') : t('emailConfirm')}
      send={(values) =>
        postJson(`/api/admin/users/${user.uid}/email`, {
          email: values.email,
          ...(mailConfigured ? {} : { verified: verified === 'verified' }),
        })
      }
      done={(data) => {
        const result = data as { status: 'pending'; pendingEmail: string } | { status: 'changed'; user: Target }
        return result.status === 'pending'
          ? t('emailPending', { email: result.pendingEmail })
          : t('emailDone', { email: result.user.email })
      }}
    >
      <p className="text-sm text-text">{t('emailCurrent', { email: user.email })}</p>
      <Field label={t('newEmailLabel')} name="email">
        <Input type="email" maxLength={255} required autoComplete="off" />
      </Field>
      {!mailConfigured && (
        <Field
          label={t('emailVerifiedLabel')}
          name="verified"
          nativeLabel={false}
          description={requireVerification ? t('emailUnverifiedHint') : undefined}
        >
          <Select
            required
            value={verified}
            onValueChange={setVerified}
            options={[
              { value: 'verified', label: t('emailVerifiedYes') },
              { value: 'unverified', label: t('emailVerifiedNo') },
            ]}
          />
        </Field>
      )}
    </ActionDialog>
  )
}

/**
 * 标记邮箱已验证或未验证，两个方向都是显式的值（ADR-0036）。标成已验证要带上页面上显示的地址：
 * 别人刚改过邮箱时，接口返回 email_changed，刷新后重来
 */
export function VerifiedDialog({
  user,
  verified,
  requireVerification,
}: {
  user: Target
  verified: boolean
  requireVerification: boolean
}) {
  const t = useTranslations('admin.userDetail.account')
  const next = !verified
  return (
    <ActionDialog
      id="admin-email-verified"
      danger={!next && requireVerification}
      trigger={<Button size="sm">{next ? t('markVerified') : t('markUnverified')}</Button>}
      title={next ? t('markVerifiedTitle', { email: user.email }) : t('markUnverifiedTitle', { email: user.email })}
      description={
        next ? t('markVerifiedHint') : requireVerification ? t('markUnverifiedHintLocked') : t('markUnverifiedHint')
      }
      confirm={next ? t('markVerified') : t('markUnverified')}
      send={() =>
        sendJson(
          'PATCH',
          `/api/admin/users/${user.uid}`,
          next ? { emailVerified: true, expectedEmail: user.email } : { emailVerified: false },
        )
      }
      done={() => (next ? t('markedVerified') : t('markedUnverified'))}
    />
  )
}
