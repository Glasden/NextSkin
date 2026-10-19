'use client'

import { Button, Checkbox, Field, Input, useToast } from '@nextskin/ui'
import { useFormatter, useTranslations } from 'next-intl'
import { Copy } from 'pixelarticons/react/Copy.js'
import { Reload } from 'pixelarticons/react/Reload.js'
import { useState } from 'react'
import { postJson, sendJson } from '../../../../lib/api-client'
import { ActionDialog } from '../../action-dialog'

type Revoked = { revokedSessions: number; revokedTokens: number }

// 去掉了容易看错的 0 O 1 l I，管理员要把它念给或抄给用户
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 16 位随机密码，拒绝采样，每一位均匀分布 */
function randomPassword(length = 16): string {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length)
  let result = ''
  while (result.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && result.length < length) result += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]
    }
  }
  return result
}

/** 只在页面上校验的字段错误，形状同接口的错误响应，交给 ActionDialog 显示 */
function fieldError(field: string, message: string) {
  const error = { code: 'invalid', message }
  return Promise.resolve({ status: 400, data: { error: { ...error, fields: { [field]: error } } } })
}

export interface SetPasswordDialogProps {
  uid: number
  nickname: string
  min: number
  max: number
  passkeys: number
  /** 全部第三方绑定的名字，包括插件停用了的 */
  bindings: string[]
  sessions: number
  launcherTokens: number
}

/**
 * 设置密码，可选"收回账号"（ADR-0036"改密码和收回账号"）：同一个请求里删掉全部通行密钥、解绑全部第三方账号、
 * 把邮箱换成管理员核实过的地址，和作废在途的登录一起提交。随机密码只显示这一次
 */
export function SetPasswordDialog({
  uid,
  nickname,
  min,
  max,
  passkeys,
  bindings,
  sessions,
  launcherTokens,
}: SetPasswordDialogProps) {
  const t = useTranslations('admin.userDetail.security')
  const format = useFormatter()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [takeover, setTakeover] = useState(false)
  const [changeEmail, setChangeEmail] = useState(false)

  const effects = [
    t('passwordRevokes', { sessions, tokens: launcherTokens }),
    t('passwordRevokesPending'),
    takeover
      ? passkeys > 0 || bindings.length > 0
        ? t('takeoverRemoves', { passkeys, bindings: bindings.length, names: format.list(bindings) })
        : t('takeoverNothing')
      : passkeys > 0 || bindings.length > 0
        ? t('passwordKeeps', { passkeys, bindings: bindings.length })
        : null,
  ].filter((item): item is string => item !== null)

  return (
    // 固定用 danger：改密码总会作废全部登录。按收回账号切换的话，对话框开着时会从 Dialog 换成 AlertDialog，
    // 整棵子树重新挂载，焦点跳走
    <ActionDialog
      id="admin-password"
      fields={['password', 'newEmail', 'newEmailRepeat']}
      rename={{ email: 'newEmail' }}
      danger
      trigger={<Button size="sm">{t('setPassword')}</Button>}
      title={t('passwordTitle', { nickname })}
      description={t('passwordHint')}
      confirm={takeover ? t('takeoverConfirm') : t('passwordConfirm')}
      onOpen={() => {
        setPassword('')
        setTakeover(false)
        setChangeEmail(false)
      }}
      send={(values) => {
        const newEmail = typeof values.newEmail === 'string' ? values.newEmail.trim() : ''
        const repeat = typeof values.newEmailRepeat === 'string' ? values.newEmailRepeat.trim() : ''
        if (takeover && changeEmail && newEmail.toLowerCase() !== repeat.toLowerCase())
          return fieldError('newEmailRepeat', t('emailMismatch'))
        return postJson(`/api/admin/users/${uid}/password`, {
          password,
          ...(takeover ? { removeOtherMethods: true } : {}),
          ...(takeover && changeEmail ? { newEmail } : {}),
        })
      }}
      done={(data) => {
        const result = data as Revoked
        return t(takeover ? 'takenOver' : 'passwordChanged', {
          sessions: result.revokedSessions,
          tokens: result.revokedTokens,
        })
      }}
    >
      <Field label={t('password')} name="password" description={t('passwordRule', { min, max })}>
        <Input
          value={password}
          onValueChange={setPassword}
          minLength={min}
          maxLength={max}
          required
          autoComplete="new-password"
          spellCheck={false}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setPassword(randomPassword())}>
          <Reload aria-hidden />
          {t('generate')}
        </Button>
        <Button
          size="sm"
          disabled={password === ''}
          onClick={() => {
            navigator.clipboard.writeText(password).then(
              () => toast.show({ tone: 'success', title: t('copied') }),
              () => toast.show({ tone: 'danger', title: t('copyFailed') }),
            )
          }}
        >
          <Copy aria-hidden />
          {t('copy')}
        </Button>
      </div>
      <p className="text-sm text-pretty text-text-muted">{t('generateHint')}</p>
      <Checkbox checked={takeover} onCheckedChange={setTakeover}>
        {t('takeover')}
      </Checkbox>
      {takeover && (
        <div className="flex flex-col gap-4 border-l-2 border-border-strong pl-4">
          <p className="text-sm text-pretty text-text-muted">{t('takeoverHint')}</p>
          <Checkbox checked={changeEmail} onCheckedChange={setChangeEmail}>
            {t('takeoverEmail')}
          </Checkbox>
          {changeEmail && (
            <>
              <Field label={t('newEmail')} name="newEmail" description={t('newEmailHint')}>
                <Input type="email" maxLength={255} required autoComplete="off" />
              </Field>
              <Field label={t('newEmailRepeat')} name="newEmailRepeat">
                <Input type="email" maxLength={255} required autoComplete="off" />
              </Field>
            </>
          )}
        </div>
      )}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-pretty text-text">
        {effects.map((item) => (
          <li key={item}>{item}</li>
        ))}
        {takeover && <li>{t('takeoverAfter')}</li>}
      </ul>
    </ActionDialog>
  )
}

/** 关两步验证：删掉验证器、备用码和信任过的设备，不退出登录（ADR-0036"关两步验证"） */
export function DisableTwoFactorDialog({ uid, nickname }: { uid: number; nickname: string }) {
  const t = useTranslations('admin.userDetail.security')
  return (
    <ActionDialog
      id="admin-two-factor"
      danger
      trigger={<Button size="sm">{t('disableTwoFactor')}</Button>}
      title={t('disableTwoFactorTitle', { nickname })}
      description={t('disableTwoFactorHint')}
      confirm={t('disableTwoFactor')}
      send={() => sendJson('DELETE', `/api/admin/users/${uid}/two-factor`)}
      done={() => t('twoFactorDisabled', { nickname })}
    />
  )
}

/** 删掉全部通行密钥，同时作废在途的登录；不能删掉最后一种能用的登录方式（ADR-0036"删通行密钥"） */
export function DeletePasskeysDialog({ uid, nickname, count }: { uid: number; nickname: string; count: number }) {
  const t = useTranslations('admin.userDetail.security')
  return (
    <ActionDialog
      id="admin-passkeys"
      danger
      trigger={<Button size="sm">{t('deletePasskeys')}</Button>}
      title={t('deletePasskeysTitle', { nickname, count })}
      description={t('deletePasskeysHint')}
      confirm={t('deletePasskeys')}
      send={() => sendJson('DELETE', `/api/admin/users/${uid}/passkeys`)}
      done={(data) => {
        const result = data as Revoked & { deleted: number }
        return t('passkeysDeleted', {
          count: result.deleted,
          sessions: result.revokedSessions,
          tokens: result.revokedTokens,
        })
      }}
    />
  )
}

/** 替用户解绑一个第三方账号，同时作废在途的登录（ADR-0036"解绑第三方账号"） */
export function UnlinkBindingDialog({
  uid,
  nickname,
  pluginId,
  providerId,
  name,
  available,
}: {
  uid: number
  nickname: string
  pluginId: string
  providerId: string
  name: string
  available: boolean
}) {
  const t = useTranslations('admin.userDetail.security')
  return (
    <ActionDialog
      id={`admin-unlink-${pluginId}-${providerId}`}
      danger
      trigger={
        <Button size="sm" aria-label={t('unlinkLabel', { name })}>
          {t('unlink')}
        </Button>
      }
      title={t('unlinkTitle', { nickname, name })}
      description={available ? t('unlinkHint') : t('unlinkHintUnavailable')}
      confirm={t('unlink')}
      send={() =>
        sendJson(
          'DELETE',
          `/api/admin/users/${uid}/bindings/${encodeURIComponent(pluginId)}/${encodeURIComponent(providerId)}`,
        )
      }
      done={(data) => {
        const result = data as Revoked
        return t('unlinked', { name, sessions: result.revokedSessions, tokens: result.revokedTokens })
      }}
    />
  )
}

/**
 * 退出全部登录：网页会话、启动器令牌和还没完成的验证流程，不动密码和其他登录方式（ADR-0036"退出全部登录"）。
 * 确认框列出留下的通行密钥数和绑定数，并指向收回账号（ADR-0036"作废在途的登录"）
 */
export function RevokeSessionsDialog({
  uid,
  nickname,
  sessions,
  launcherTokens,
  passkeys,
  bindings,
}: {
  uid: number
  nickname: string
  sessions: number
  launcherTokens: number
  passkeys: number
  bindings: number
}) {
  const t = useTranslations('admin.userDetail.security')
  return (
    <ActionDialog
      id="admin-sessions"
      danger
      trigger={<Button size="sm">{t('revokeSessions')}</Button>}
      title={t('revokeSessionsTitle', { nickname })}
      description={t('revokeSessionsHint', { sessions, tokens: launcherTokens })}
      confirm={t('revokeSessions')}
      send={() => sendJson('DELETE', `/api/admin/users/${uid}/sessions`)}
      done={(data) => {
        const result = data as Revoked
        return t('sessionsRevoked', { sessions: result.revokedSessions, tokens: result.revokedTokens })
      }}
    >
      <p className="text-sm text-pretty text-text">{t('revokeSessionsKeeps', { passkeys, bindings })}</p>
    </ActionDialog>
  )
}
