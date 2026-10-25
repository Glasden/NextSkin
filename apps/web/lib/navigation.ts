import { announceSessionChange } from './session-change'

/**
 * 登录、注册、两步验证完成以后去 next，一律整页导航：
 * - 页头代码（ADR-0063）按登录的身份决定加不加载，有管理权限的用户登录后不加载。客户端跳转不重新加载页面，
 *   访客时加载的统计、广告脚本会接着在管理员的页面上跑。别的标签页里跑着的由 announceSessionChange 叫它们重新加载：
 *   next 不一定是页面（接口、授权后直接回到第三方的回调地址），不能等到下一页再通知；
 * - 回到授权流程的 `/api/auth/oauth2/authorize?…`（ADR-0037"登录后续跑"）时，Next 的客户端路由会先发一次 RSC 的 fetch，
 *   Better Auth 对 fetch 返回 JSON，授权要跑两遍。
 * 替换掉当前这一页：留在历史记录里的话，从同意页按后退会带着还没过期的签名参数再跑一次授权
 */
export function goToNext(next: string): void {
  announceSessionChange()
  window.location.replace(next)
}
