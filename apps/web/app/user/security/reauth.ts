import { postJson } from '../../../lib/api-client'

/**
 * 会话超过 10 分钟（session.freshAge）时，添加通行密钥、绑定第三方账号、设置密码之前要重新登录（ADR-0023、ADR-0034）。
 * 先退出再整页跳到登录页，丢掉客户端缓存的已登录页面；登录后回到安全页
 */
export async function signInAgain(): Promise<void> {
  await postJson('/api/auth/sign-out', {})
  window.location.assign(`/sign-in?next=${encodeURIComponent('/user/security')}`)
}
