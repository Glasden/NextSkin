import { JOIN_SCOPE, READ_SCOPE, SELECT_SCOPE, type SessionUser } from '@nextskin/domain'
import { Alert } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import { AvatarSquare } from 'pixelarticons/react/AvatarSquare.js'
import { Close } from 'pixelarticons/react/Close.js'
import { Gamepad } from 'pixelarticons/react/Gamepad.js'
import { Human } from 'pixelarticons/react/Human.js'
import { Mail } from 'pixelarticons/react/Mail.js'
import { Refresh } from 'pixelarticons/react/Refresh.js'
import { User } from 'pixelarticons/react/User.js'
import { Users } from 'pixelarticons/react/Users.js'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { describeScopes } from '../../lib/oauth'
import { getServer } from '../../lib/server'
import { VerifyEmailAlert } from '../user/verify-email-alert'
import type { AuthorizationPlayer } from './player-selection'

// 启动器授权页（/device）和同意页（/oauth/consent）共用的部分（ADR-0037"页面"）

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const SCOPE_ICONS: Readonly<Record<string, Icon>> = {
  openid: User,
  profile: AvatarSquare,
  email: Mail,
  offline_access: Refresh,
  [SELECT_SCOPE]: Human,
  [READ_SCOPE]: Users,
  [JOIN_SCOPE]: Gamepad,
}

/** 应用卡片：图标、名称和创建者，下面一栏是这一页要核对的东西（设备码、回调地址） */
export function ClientCard({
  icon: Icon,
  name,
  byline,
  children,
}: {
  readonly icon: Icon
  readonly name: string
  readonly byline: string
  readonly children: ReactNode
}) {
  return (
    <div className="-mt-2 flex flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex items-center gap-3 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-surface-sunken text-text-muted">
          <Icon aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col">
          {/* 应用名是创建者填的，用正文字体（DESIGN.md §4）。完整显示、可以在任意位置折行：截断以后，
              "某某启动器"后面接一串字的名字看起来就是正版；名字和昵称再长也不撑宽页面 */}
          <span className="text-lg font-medium wrap-anywhere text-text">{name}</span>
          <span className="text-sm text-pretty wrap-anywhere text-text-muted">{byline}</span>
        </div>
      </div>
      <dl className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-t border-border bg-surface-sunken px-4 py-3">
        {children}
      </dl>
    </div>
  )
}

/** 申请的权限，按 OAUTH_SCOPES 的顺序写成人话 */
export async function PermissionList({ scopes }: { readonly scopes: readonly string[] }) {
  const [t, described] = await Promise.all([getTranslations('oauth'), describeScopes(scopes)])
  return (
    <section aria-labelledby="authorization-permissions" className="flex flex-col gap-3">
      <h2 id="authorization-permissions" className="text-base font-medium text-text">
        {t('permissions')}
      </h2>
      <ul className="flex flex-col gap-2">
        {described.map(({ scope, label }) => {
          const Icon = SCOPE_ICONS[scope] ?? User
          return (
            <li key={scope} className="flex items-start gap-3 text-base text-text">
              <Icon aria-hidden className="shrink-0 text-text-muted" />
              <span className="pt-0.5 text-sm">{label}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** 申请了 Select 时列出用户的全部角色 */
export async function authorizationPlayers(uid: number): Promise<AuthorizationPlayer[]> {
  const { core } = await getServer()
  const owned = await core.players.listOwned(uid)
  return owned.map((player) => ({
    pid: player.pid,
    name: player.name,
    skin: player.skin && { hash: player.skin.hash, type: player.skin.type, scale: player.skin.scale },
  }))
}

/**
 * 授权的前提（ADR-0037"授权的前提"）：被封禁、开启了邮箱验证却还没验证时只能拒绝，返回说明原因的提示；
 * 能授权时返回 null。只决定页面显示什么，同意请求和批准用例自己再查一遍
 */
export async function authorizationBlock(user: SessionUser): Promise<ReactNode> {
  const { core } = await getServer()
  const t = await getTranslations('oauth')
  if (user.role === 'banned') return <Alert tone="danger">{t('banned')}</Alert>
  const settings = await core.settings.read(['auth.requireEmailVerification'])
  if (!settings['auth.requireEmailVerification']) return null
  const overview = await core.users.overview(user.uid)
  if (overview === null || overview.emailVerified) return null
  return <VerifyEmailAlert email={overview.email} mailConfigured={await core.mail.configured()} />
}

/** 授权流程走不下去时的整页说明：叉形图标、标题和一段话，下面可以放一个按钮 */
export function AuthorizationNotice({
  title,
  children,
  action,
}: {
  readonly title: string
  readonly children: ReactNode
  readonly action?: ReactNode
}) {
  return (
    <div role="status" className="flex flex-col items-start gap-4">
      <span className="grid size-12 place-items-center rounded-sm bg-surface-sunken text-text-muted">
        <Close aria-hidden />
      </span>
      <h1 className="font-pixel text-pixel-2 text-text">{title}</h1>
      <div className="flex flex-col gap-2 text-base text-pretty text-text">{children}</div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
