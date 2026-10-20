import type { useRouter } from 'next/navigation'

/**
 * 登录、注册、两步验证完成以后去 next。回到授权流程的 `/api/auth/oauth2/authorize?…`（ADR-0037"登录后续跑"）
 * 整页导航：Next 的客户端路由会先发一次 RSC 的 fetch，Better Auth 对 fetch 返回 JSON，授权要跑两遍。
 * 和另一个分支一样替换掉当前这一页：留在历史记录里的话，从同意页按后退会带着还没过期的签名参数再跑一次授权
 */
export function goToNext(router: ReturnType<typeof useRouter>, next: string): void {
  if (next.startsWith('/api/')) {
    window.location.replace(next)
    return
  }
  router.replace(next)
  router.refresh()
}
