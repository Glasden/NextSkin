import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'

// generateId: 'serial' 下，Better Auth 靠"确定性主键 + 重复插入即冲突"实现的单次使用检查不起作用（ADR-0015
// "对 ADR-0007 的补充"）。受影响的能力在这里统一关掉：
// - DPoP：oauthProvider 的 dpop.signingAlgorithms 设为空数组，带 DPoP proof 的请求一律被拒绝（见 auth.ts）；
// - private_key_jwt：它固定在支持的认证方式里，不能靠配置去掉，所以创建、修改客户端时只接受白名单里的方式，
//   在会做客户端认证的端点上拒绝 client_assertion；
// - magic-link、email-otp、SIWE：不启用（auth.ts 的插件列表）。
// 单次使用的找回密码令牌走 consumeVerificationValue，不受影响。

/** 会写入客户端认证方式的端点 */
const CLIENT_WRITE_PATHS = new Set([
  '/oauth2/create-client',
  '/admin/oauth2/create-client',
  '/oauth2/update-client',
  '/admin/oauth2/update-client',
  '/oauth2/register',
])

/** 会做客户端认证的端点（extractClientCredentials 的调用方） */
const CLIENT_AUTHENTICATION_PATHS = new Set(['/oauth2/token', '/oauth2/introspect', '/oauth2/revoke', '/device/code'])

const UNSUPPORTED_METHOD = 'private_key_jwt'

/**
 * 客户端只能登记这几种认证方式。用白名单而不是只拦 private_key_jwt：Better Auth 会先 trim 再校验，
 * 前后带空白的 ' private_key_jwt ' 照样会被存成 private_key_jwt；插件扩展的认证方式也一并挡住
 */
const ALLOWED_METHODS = new Set(['none', 'client_secret_basic', 'client_secret_post'])

function requestsUnsupportedMethod(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const record = body as Record<string, unknown>
  const update = record.update && typeof record.update === 'object' ? (record.update as Record<string, unknown>) : {}
  // 不是字符串的值交给 Better Auth 的输入校验拒绝
  return [record.token_endpoint_auth_method, update.token_endpoint_auth_method].some(
    (method) => typeof method === 'string' && !ALLOWED_METHODS.has(method.trim()),
  )
}

function hasClientAssertion(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  return 'client_assertion' in body || 'client_assertion_type' in body
}

/**
 * 发现文档里去掉不支持的能力：private_key_jwt 和它的签名算法、DPoP 的签名算法。
 * 只改返回值，不改 Better Auth 的行为；行为由上面的钩子和 auth.ts 的配置保证。
 */
export function withoutSerialUnsafeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'dpop_signing_alg_values_supported' || key.endsWith('_endpoint_auth_signing_alg_values_supported'))
      continue
    result[key] =
      key.endsWith('_endpoint_auth_methods_supported') && Array.isArray(value)
        ? value.filter((method) => method !== UNSUPPORTED_METHOD)
        : value
  }
  return result
}

export function serialSafety() {
  return {
    id: 'nextskin-serial-safety',
    hooks: {
      before: [
        {
          matcher: (ctx) => CLIENT_WRITE_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware((ctx) => {
            if (requestsUnsupportedMethod(ctx.body))
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_client_metadata',
                error_description: 'unsupported token_endpoint_auth_method',
              })
            return Promise.resolve()
          }),
        },
        {
          // Better Auth 会再读一遍原始请求体，但读到的是同一份内容：这里看到的 body 里没有，它那里也没有
          matcher: (ctx) => CLIENT_AUTHENTICATION_PATHS.has(ctx.path ?? ''),
          handler: createAuthMiddleware((ctx) => {
            if (hasClientAssertion(ctx.body))
              throw new APIError('BAD_REQUEST', {
                error: 'invalid_client',
                error_description: 'client assertions are not supported',
              })
            return Promise.resolve()
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin
}
