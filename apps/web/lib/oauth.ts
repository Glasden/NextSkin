import { JOIN_SCOPE, OAUTH_SCOPES, READ_SCOPE, SELECT_SCOPE, type OAuthClientSummary } from '@nextskin/domain'
import { getTranslations } from 'next-intl/server'

// 文案的键名不能带点（packages/i18n 的测试），Yggdrasil 的 scope 换成嵌套的键
const SCOPE_KEYS: Readonly<Record<string, string>> = {
  openid: 'openid',
  profile: 'profile',
  email: 'email',
  offline_access: 'offlineAccess',
  [SELECT_SCOPE]: 'playerSelect',
  [READ_SCOPE]: 'playerRead',
  [JOIN_SCOPE]: 'serverJoin',
}

/** 申请的权限写成人话，按 OAUTH_SCOPES 的顺序（ADR-0037"页面"）；认不出的 scope 原样显示 */
export async function describeScopes(scopes: readonly string[]): Promise<{ scope: string; label: string }[]> {
  const t = await getTranslations('oauth.scopes')
  const order = (scope: string) => {
    const index = OAUTH_SCOPES.indexOf(scope)
    return index === -1 ? OAUTH_SCOPES.length : index
  }
  return [...new Set(scopes)]
    .sort((a, b) => order(a) - order(b))
    .map((scope) => {
      const key = SCOPE_KEYS[scope]
      return { scope, label: key ? t(key as 'openid') : scope }
    })
}

/**
 * OAuth 的 issuer，同 Better Auth 的 baseURL（ADR-0037"发现文档"）：填了站点地址就用它，没填时按这次请求的地址，
 * 同 yggdrasilApiUrl。发现文档在它后面加 `/.well-known/openid-configuration`
 */
export function oauthIssuer(siteUrl: string, requestRoot: string): string {
  return `${(siteUrl || requestRoot).replace(/\/+$/, '')}/api/auth`
}

/**
 * 应用在界面上的名字和下面一行说明。公用应用没有名称和创建者，名字按站点名生成，并说明任何启动器都能以它的名义
 * 发起登录（ADR-0037"公用应用"）；名称是创建者填的，属于用户产生的内容
 */
export async function clientLabel(
  client: OAuthClientSummary,
  siteName: string,
): Promise<{ name: string; byline: string }> {
  const t = await getTranslations('oauth')
  if (client.shared) return { name: t('sharedClient', { site: siteName }), byline: t('sharedHint') }
  return {
    name: client.name ?? t('unnamedClient'),
    byline: client.owner ? t('owner', { nickname: client.owner.nickname }) : t('noOwner'),
  }
}
