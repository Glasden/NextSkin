import { hasAdminAccess, type Core } from '@nextskin/domain'

export type MaintenanceClass = 'open' | 'protocol' | 'restricted'

/** 按 ADR-0044 分类；页面和端点共用规则，末尾的斜杠不影响分类。 */
export function classifyMaintenance(surface: 'page' | 'endpoint', path: string): MaintenanceClass {
  path = path.replace(/\/+$/, '')
  if (surface === 'page') {
    if (/^\/(?:sign-in(?:\/two-factor)?|maintenance|setup(?:\/.*)?)$/.test(path)) return 'open'
    if (/^\/(?:device|oauth\/(?:consent|error))$/.test(path)) return 'protocol'
    return 'restricted'
  }
  if (
    path === '/api/health' ||
    path === '/ads.txt' ||
    /^\/(?:site-images|render)(?:\/.*)?$/.test(path) ||
    /^\/api\/(?:setup|import\/run)(?:\/.*)?$/.test(path) ||
    /^\/api\/auth\/(?:sign-in\/email|two-factor\/verify-(?:totp|backup-code)|passkey\/(?:generate-authenticate-options|verify-authentication)|sign-out)$/.test(
      path,
    ) ||
    /^\/api\/external-login\/[^/]+\/[^/]+(?:\/callback)?$/.test(path)
  )
    return 'open'
  if (
    /^\/api\/yggdrasil(?:\/.*)?$/.test(path) ||
    /^\/(?:csl|usm)(?:\/.*)?$/.test(path) ||
    /^\/[^/]+\.json$/.test(path) ||
    /^\/(?:skin|cape)\/[^/]+\.png$/.test(path) ||
    /^\/textures\/.*$/.test(path) ||
    /^\/api\/auth\/(?:oauth2|device|\.well-known)\/.*$/.test(path) ||
    path === '/api/auth/jwks' ||
    /^\/api\/user\/device\/.*$/.test(path)
  )
    return 'protocol'
  return 'restricted'
}

/** 只在分类要求管理员时读取会话；没带 Cookie 的请求直接拒绝，避免查询数据库。 */
export async function allowedDuringMaintenance(
  core: Core,
  surface: 'page' | 'endpoint',
  request: { path: string; headers: Headers; root: string },
  blockProtocols: boolean,
): Promise<boolean> {
  const classification = classifyMaintenance(surface, request.path)
  if (classification === 'open' || (classification === 'protocol' && !blockProtocols)) return true
  if (!request.headers.get('cookie')) return false
  const user = await core.auth.getSessionUser(request.headers, request.root)
  return user !== null && hasAdminAccess(user.role)
}
