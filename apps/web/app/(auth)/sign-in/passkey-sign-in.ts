'use client'

import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authErrorCode, getJson, postJson } from '../../../lib/api-client'
import { useWebAuthnSupported, webAuthnFailure } from '../../../lib/webauthn'

export type PasskeyFailure = 'failed' | 'expired'

/**
 * 用通行密钥登录。认证参数在页面打开时就取好：有的浏览器（Safari）要求点击按钮的那一刻直接调起通行密钥，
 * 中间不能再等网络请求。浏览器支持时，同一份参数先挂在邮箱输入框的自动填充上；点按钮会取消自动填充、
 * 改用弹出的提示框，参数里的挑战还没用过，可以接着用（ADR-0023）
 */
export function usePasskeySignIn(onSignedIn: () => void) {
  // 服务端渲染时不显示按钮：不支持的浏览器上不能出现一个点了没用的按钮
  const supported = useWebAuthnSupported(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<PasskeyFailure | null>(null)
  const options = useRef<PublicKeyCredentialRequestOptionsJSON | null>(null)
  const autofill = useRef(false)
  const modal = useRef(false)

  const verify = useCallback(
    async (response: AuthenticationResponseJSON) => {
      const { status, data } = await postJson('/api/auth/passkey/verify-authentication', { response })
      if (status === 200) {
        onSignedIn()
        return true
      }
      // 挑战 Cookie 过期（打开页面太久）时 Better Auth 报 CHALLENGE_NOT_FOUND
      setFailure(authErrorCode(data) === 'CHALLENGE_NOT_FOUND' ? 'expired' : 'failed')
      return false
    },
    [onSignedIn],
  )

  /** 取一份新的认证参数，浏览器支持时挂到自动填充上；自动填充登录失败后再取一份，继续等 */
  const arm = useCallback(async () => {
    for (;;) {
      const { status, data } = await getJson('/api/auth/passkey/generate-authenticate-options')
      options.current = status === 200 ? (data as PublicKeyCredentialRequestOptionsJSON) : null
      if (!options.current || !autofill.current || modal.current) return
      let response: AuthenticationResponseJSON
      try {
        response = await startAuthentication({ optionsJSON: options.current, useBrowserAutofill: true })
      } catch {
        // 被按钮发起的登录取代，或者离开了页面
        return
      }
      if (await verify(response)) return
    }
  }, [verify])

  useEffect(() => {
    if (!supported) return
    void browserSupportsWebAuthnAutofill().then((available) => {
      autofill.current = available
      void arm()
    })
    return () => WebAuthnAbortService.cancelCeremony()
  }, [supported, arm])

  async function start() {
    const optionsJSON = options.current
    setFailure(null)
    if (!optionsJSON) {
      setFailure('failed')
      void arm()
      return
    }
    modal.current = true
    setPending(true)
    try {
      // 挑战只能用一次：成功时页面跳走，失败时下面换一份新的
      if (await verify(await startAuthentication({ optionsJSON }))) return
    } catch (error) {
      if (webAuthnFailure(error) !== 'cancelled') setFailure('failed')
    }
    modal.current = false
    setPending(false)
    void arm()
  }

  return { supported, pending, failure, start }
}
