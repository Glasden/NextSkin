/**
 * 启动器里填的外置登录 API 地址（ADR-0030）。填了站点地址就用它，与邮件里的链接一致；没填时按这次请求的地址。
 * 站点地址可能以 / 结尾，拼出 `//api/yggdrasil` 会被 Next 308 跳转，旧版 Java 不跟随
 */
export function yggdrasilApiUrl(siteUrl: string, requestRoot: string): string {
  return `${(siteUrl || requestRoot).replace(/\/+$/, '')}/api/yggdrasil`
}
