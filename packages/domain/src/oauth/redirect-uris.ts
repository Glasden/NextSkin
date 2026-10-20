// 复制自 @better-auth/oauth-provider 1.7.10 的同名函数；同上游使用 core 导出的主机和自定义协议判断。
import { isLoopbackIP } from '@better-auth/core/utils/host'
import { isNativePrivateUseRedirectUri } from '@better-auth/core/utils/redirect-uri'
import { DomainError } from '../errors.ts'
import type { OAuthClientType } from './clients.ts'

function getRawHttpHostname(redirectUri: string) {
  const authority = /^http:\/\/([^/?#]*)/i.exec(redirectUri)?.[1]
  if (!authority) return null
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostAndPort.startsWith('[')) {
    const bracketEnd = hostAndPort.indexOf(']')
    return bracketEnd < 0 ? null : hostAndPort.slice(0, bracketEnd + 1).toLowerCase()
  }
  return (hostAndPort.split(':')[0] ?? '').toLowerCase()
}

function isExactLoopbackHttpRedirectUri(redirectUri: string) {
  const hostname = getRawHttpHostname(redirectUri)
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function validateClientRedirectUri(redirectUri: string, applicationType: OAuthClientType): void {
  const invalidRedirectUri = (): never => {
    throw new DomainError('oauth_redirect_uri_invalid', { uri: redirectUri, type: applicationType })
  }
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch {
    return invalidRedirectUri()
  }
  if (redirectUri.includes('#') || url.username.length > 0 || url.password.length > 0) invalidRedirectUri()
  const isHttp = url.protocol === 'http:'
  const isHttps = url.protocol === 'https:'
  if (/^localhost\.+$/i.test(url.hostname)) invalidRedirectUri()
  const isRedirectLoopback = isLoopbackIP(url.hostname) || url.hostname === 'localhost'
  if (applicationType === 'web') {
    if (!isHttps || isRedirectLoopback) invalidRedirectUri()
    return
  }
  if (isHttps) {
    if (isRedirectLoopback) invalidRedirectUri()
    return
  }
  if (isHttp) {
    if (!isExactLoopbackHttpRedirectUri(redirectUri)) invalidRedirectUri()
    return
  }
  if (!isNativePrivateUseRedirectUri(url)) invalidRedirectUri()
}
