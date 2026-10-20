// Yggdrasil Connect（ADR-0037）的 scope、组合规则和角色绑定的编码。Better Auth 的钩子、设备授权、
// 进服校验、吊销和导入器都从这里取，不各写一份字符串

export const SELECT_SCOPE = 'Yggdrasil.PlayerProfiles.Select'
export const READ_SCOPE = 'Yggdrasil.PlayerProfiles.Read'
export const JOIN_SCOPE = 'Yggdrasil.Server.Join'
export const YGGDRASIL_SCOPES: readonly string[] = [SELECT_SCOPE, READ_SCOPE, JOIN_SCOPE]

/** 授权服务器支持的全部 scope，也是发现文档的 `scopes_supported` */
export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access', SELECT_SCOPE, READ_SCOPE, JOIN_SCOPE]

/** 公用应用（迁移 0042 插入的那一行）的 client_id，发现文档里的 `shared_client_id` */
export const SHARED_OAUTH_CLIENT_ID = 'shared'
/** 公用应用能申请的 scope：不能申请 `email`（规范建议限制公用应用申请敏感的 scope） */
export const SHARED_CLIENT_SCOPES = OAUTH_SCOPES.filter((scope) => scope !== 'email')

/** RFC 8628 的授权方式；客户端的 `grant_types` 里有它才能走设备码流程 */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** 按 Better Auth 的方式拆 scope 参数：空格分隔，去掉空串 */
export function splitScopes(value: string | null | undefined): string[] {
  return (value ?? '').split(' ').filter(Boolean)
}

/**
 * scope 是否符合 Connect 的组合规则（ADR-0037"scope"）：都是支持的 scope；有任一 Yggdrasil scope 就必须有 `openid`；
 * Select 和 Read 不能同时申请；有 Join 就必须有 Select。不满足时由调用方返回 `invalid_scope`
 */
export function isValidScopeSet(scopes: readonly string[]): boolean {
  if (scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) return false
  const has = (scope: string) => scopes.includes(scope)
  if (YGGDRASIL_SCOPES.some(has) && !has('openid')) return false
  if (has(SELECT_SCOPE) && has(READ_SCOPE)) return false
  return !has(JOIN_SCOPE) || has(SELECT_SCOPE)
}

/** OAuth 表里的 `scopes` 列：SQLite 读出 JSON 字符串，MySQL、PostgreSQL 读出已解析的数组 */
export function readScopes(value: unknown): string[] {
  let parsed: unknown = value
  if (typeof value === 'string')
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  return Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === 'string') : []
}

const PLAYER_REFERENCE = /^player:([1-9]\d{0,15})$/

/** 所选角色存在同意记录、访问令牌和刷新令牌的 `reference_id` 上（ADR-0007） */
export function playerReference(pid: number): string {
  return `player:${pid}`
}

/** 严格解析：`player:0`、`player:1e3`、`player:05` 都不算 */
export function parsePlayerReference(value: string | null | undefined): number | null {
  const match = PLAYER_REFERENCE.exec(value ?? '')
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) ? pid : null
}

/** 设备码的用户代码：Better Auth 默认的字符集，查找时按它的规则规范化（大小写、连字符） */
const USER_CODE_CHARSET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/

/**
 * 用户代码的查找顺序，照抄 Better Auth（device-authorization 的 findDeviceCodeByUserCode）：先按原样查，
 * 再按规范化之后的值查；规范化的值不在默认字符集里就不再查。两次查到的行都要逐字复核
 */
export function userCodeCandidates(input: string): string[] {
  const normalized = input.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  return normalized !== input && USER_CODE_CHARSET.test(normalized) ? [input, normalized] : [input]
}
