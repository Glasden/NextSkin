import { browserSupportsWebAuthn, WebAuthnError } from '@simplewebauthn/browser'
import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

/**
 * 浏览器支不支持通行密钥。服务端渲染时不知道，用 serverValue；水合之后换成浏览器的真实结果。
 * 支持与否在页面的生命周期里不会变，所以不需要订阅
 */
export function useWebAuthnSupported(serverValue: boolean): boolean {
  return useSyncExternalStore(subscribe, browserSupportsWebAuthn, () => serverValue)
}

/**
 * 浏览器调起通行密钥失败的原因。用户关掉提示框、超时都报 NotAllowedError（@simplewebauthn/browser 原样放在
 * cause 里），这类情况不算出错，页面只说一声“已取消”
 */
export function webAuthnFailure(error: unknown): 'cancelled' | 'duplicate' | 'other' {
  if (error instanceof WebAuthnError) {
    if (error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'duplicate'
    if (error.code === 'ERROR_CEREMONY_ABORTED') return 'cancelled'
    if (error.cause instanceof Error && error.cause.name === 'NotAllowedError') return 'cancelled'
    return 'other'
  }
  return error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
    ? 'cancelled'
    : 'other'
}
