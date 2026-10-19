import { createTranslator, type Locale } from '@nextskin/i18n'
import { markup, style, toString, type SafeHtml } from './html.ts'
import { colors, fontSans } from './tokens.ts'

export interface RenderedMail {
  subject: string
  html: string
  text: string
}

/** 带一个操作链接的邮件：验证邮箱、重设密码 */
export interface LinkMailInput {
  /** 收件人的语言（ADR-0019：按收件人，不按触发者） */
  locale: Locale
  siteName: string
  nickname: string
  url: string
  /** 链接多少小时后失效 */
  expiresInHours: number
}

// 每个文字元素都写上字体：有些客户端（Outlook）不从外层继承
const paragraph = (extra: Record<string, string | number> = {}) =>
  style({
    margin: '0 0 16px',
    fontFamily: fontSans,
    fontSize: 16,
    lineHeight: '24px',
    color: colors.text,
    ...extra,
  })
const muted = (extra: Record<string, string | number> = {}) =>
  paragraph({ margin: '0 0 8px', fontSize: 14, lineHeight: '20px', color: colors['text-muted'], ...extra })

/**
 * 标志：皮肤头部六个面的展开图（DESIGN.md §2.2），每格 6px。用表格单元格的底色拼，
 * 不用图片和 SVG：很多客户端默认不加载图片，Gmail 不显示 SVG
 */
function mark(): SafeHtml {
  const cell = (color: string | null) =>
    color
      ? markup`<td width="6" height="6" bgcolor="${color}" style="${style({ width: 6, height: 6, padding: 0, backgroundColor: color })}"></td>`
      : markup`<td width="6" height="6" style="${style({ width: 6, height: 6, padding: 0 })}"></td>`
  return markup`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${cell(null)}${cell(colors.text)}${cell(colors['text-muted'])}${cell(null)}</tr><tr>${cell(colors['border-strong'])}${cell(colors.accent)}${cell(colors['border-strong'])}${cell(colors['text-muted'])}</tr></table>`
}

/**
 * 主要按钮：强调色、2px 圆角、硬边阴影（DESIGN.md §2）。用加粗的同色边框撑出按钮的大小，
 * Outlook 也能显示，整块区域都能点；不支持 box-shadow 的客户端只是没有阴影
 */
function button(href: string, label: string): SafeHtml {
  const link = style({
    display: 'inline-block',
    border: `12px solid ${colors.accent}`,
    borderLeftWidth: 24,
    borderRightWidth: 24,
    borderRadius: 2,
    backgroundColor: colors.accent,
    boxShadow: `2px 2px 0 0 ${colors.shadow}`,
    color: colors['accent-fg'],
    fontFamily: fontSans,
    fontSize: 16,
    lineHeight: '24px',
    fontWeight: '500',
    textDecoration: 'none',
  })
  return markup`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${colors.accent}" style="${style({ borderRadius: 2 })}"><a href="${href}" target="_blank" style="${link}">${label}</a></td></tr></table>`
}

function layout(input: {
  locale: Locale
  subject: string
  siteName: string
  preview: string
  content: SafeHtml
  footer: string
}): string {
  // 预览文字：收件箱列表里主题后面的那一行，正文里不显示
  const preview = style({ display: 'none', maxHeight: 0, overflow: 'hidden', opacity: '0', color: colors.bg })
  const brand = style({
    verticalAlign: 'middle',
    fontFamily: fontSans,
    fontSize: 16,
    lineHeight: '24px',
    fontWeight: '600',
    color: colors.text,
  })
  const card = style({
    padding: 32,
    backgroundColor: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
  })
  return toString(markup`<!DOCTYPE html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${input.subject}</title>
</head>
<body style="${style({ margin: 0, padding: 0, backgroundColor: colors.bg })}">
<div style="${preview}">${input.preview}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${colors.bg}" style="${style({ backgroundColor: colors.bg })}">
<tr><td align="center" style="${style({ padding: '32px 16px' })}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${style({ maxWidth: 480 })}">
<tr><td style="${style({ padding: '0 0 16px' })}">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="${style({ paddingRight: 12, verticalAlign: 'middle' })}">${mark()}</td>
<td style="${brand}">${input.siteName}</td>
</tr></table>
</td></tr>
<tr><td bgcolor="${colors.surface}" style="${card}">
${input.content}
</td></tr>
<tr><td style="${muted({ margin: 0, padding: '16px 0 0', fontSize: 12, lineHeight: '16px' })}">${input.footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`)
}

function renderLinkMail(
  input: LinkMailInput,
  kind: 'verifyEmail' | 'resetPassword' | 'confirmEmailChange',
): RenderedMail {
  const t = createTranslator(input.locale)
  const site = { siteName: input.siteName }
  const subject = t(`mail.${kind}.subject`, site)
  const greeting = t('mail.greeting', { nickname: input.nickname })
  const body = t(`mail.${kind}.body`, { hours: input.expiresInHours })
  const action = t(`mail.${kind}.action`)
  const ignore = t(`mail.${kind}.ignore`, site)
  const footer = t('mail.footer', site)
  const link = style({ color: colors.accent, textDecoration: 'underline' })

  const content = markup`<p style="${paragraph()}">${greeting}</p>
<p style="${paragraph({ margin: '0 0 24px' })}">${body}</p>
${button(input.url, action)}
<p style="${muted({ margin: '24px 0 4px' })}">${t('mail.linkFallback')}</p>
<p style="${muted({ margin: '0 0 24px', wordBreak: 'break-all' })}"><a href="${input.url}" target="_blank" style="${link}">${input.url}</a></p>
<p style="${muted({ margin: 0 })}">${ignore}</p>`

  return {
    subject,
    html: layout({ locale: input.locale, subject, siteName: input.siteName, preview: body, content, footer }),
    text: [greeting, body, t('mail.actionLink', { action, url: input.url }), ignore, footer].join('\n\n'),
  }
}

export function renderVerifyEmail(input: LinkMailInput): RenderedMail {
  return renderLinkMail(input, 'verifyEmail')
}

export function renderResetPassword(input: LinkMailInput): RenderedMail {
  return renderLinkMail(input, 'resetPassword')
}

export function renderConfirmEmailChange(input: LinkMailInput): RenderedMail {
  return renderLinkMail(input, 'confirmEmailChange')
}

export type NoticeMailInput = Omit<LinkMailInput, 'url' | 'expiresInHours'>

export function renderEmailChanged(input: NoticeMailInput): RenderedMail {
  const t = createTranslator(input.locale)
  const site = { siteName: input.siteName }
  const subject = t('mail.emailChanged.subject', site)
  const greeting = t('mail.greeting', { nickname: input.nickname })
  const body = t('mail.emailChanged.body')
  const footer = t('mail.footer', site)
  const content = markup`<p style="${paragraph()}">${greeting}</p>
<p style="${paragraph({ margin: 0 })}">${body}</p>`
  return {
    subject,
    html: layout({ locale: input.locale, subject, siteName: input.siteName, preview: body, content, footer }),
    text: [greeting, body, footer].join('\n\n'),
  }
}

/** 账号绑定了第三方账号的通知（ADR-0034）：账号被盗用时，原主人至少能知道。不带链接 */
export function renderExternalAccountLinked(input: NoticeMailInput & { provider: string }): RenderedMail {
  const t = createTranslator(input.locale)
  const site = { siteName: input.siteName }
  const subject = t('mail.externalAccountLinked.subject', { ...site, provider: input.provider })
  const greeting = t('mail.greeting', { nickname: input.nickname })
  const body = t('mail.externalAccountLinked.body', { provider: input.provider })
  const footer = t('mail.footer', site)
  const content = markup`<p style="${paragraph()}">${greeting}</p>
<p style="${paragraph({ margin: 0 })}">${body}</p>`
  return {
    subject,
    html: layout({ locale: input.locale, subject, siteName: input.siteName, preview: body, content, footer }),
    text: [greeting, body, footer].join('\n\n'),
  }
}

/** 管理员对账号做的一项修改，通知邮件里一项一行 */
export type AdminAccountChange =
  // 通知发到旧地址，旧邮箱可能已经落到别人手里，所以不写新地址，同 emailChanged
  | { kind: 'email'; pending: boolean }
  | { kind: 'password' }
  | { kind: 'twoFactor' }
  | { kind: 'passkeys'; count: number }
  | { kind: 'binding'; provider: string } // 已按收件人的语言翻译好的第三方名称
  | { kind: 'playerRenamed'; from: string; to: string }
  | { kind: 'playerDeleted'; name: string }
  | { kind: 'playerTransferredOut'; name: string }
  | { kind: 'playerTransferredIn'; name: string }

export interface AdminAccountChangedInput extends NoticeMailInput {
  changes: readonly AdminAccountChange[]
  /** 修改的时刻（ISO 时间）和站点时区：邮件里按收件人的语言和站点时区写出时间 */
  at: string
  timeZone: string
}

function adminChangeLine(t: ReturnType<typeof createTranslator>, change: AdminAccountChange): string {
  switch (change.kind) {
    case 'email':
      return change.pending
        ? t('mail.adminAccountChanged.changes.emailPending')
        : t('mail.adminAccountChanged.changes.email')
    case 'password':
      return t('mail.adminAccountChanged.changes.password')
    case 'twoFactor':
      return t('mail.adminAccountChanged.changes.twoFactor')
    case 'passkeys':
      return t('mail.adminAccountChanged.changes.passkeys', { count: change.count })
    case 'binding':
      return t('mail.adminAccountChanged.changes.binding', { provider: change.provider })
    case 'playerRenamed':
      return t('mail.adminAccountChanged.changes.playerRenamed', { from: change.from, to: change.to })
    case 'playerDeleted':
      return t('mail.adminAccountChanged.changes.playerDeleted', { name: change.name })
    case 'playerTransferredOut':
      return t('mail.adminAccountChanged.changes.playerTransferredOut', { name: change.name })
    case 'playerTransferredIn':
      return t('mail.adminAccountChanged.changes.playerTransferredIn', { name: change.name })
  }
}

/**
 * 管理员修改了账号的通知（ADR-0036）：管理员账号被人滥用时，原主人至少能知道改了什么、什么时候改的。不带链接。
 * 不复用 renderEmailChanged：它写着"如果不是你本人操作"，不适合管理员直接做的修改
 */
export function renderAdminAccountChanged(input: AdminAccountChangedInput): RenderedMail {
  const t = createTranslator(input.locale)
  const site = { siteName: input.siteName }
  // 带上 UTC 偏移：收件人不一定和站点在同一个时区
  const time = new Intl.DateTimeFormat(input.locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: input.timeZone,
    timeZoneName: 'shortOffset',
  }).format(new Date(input.at))
  const subject = t('mail.adminAccountChanged.subject', site)
  const greeting = t('mail.greeting', { nickname: input.nickname })
  const body = t('mail.adminAccountChanged.body', { time })
  const lines = input.changes.map((change) => adminChangeLine(t, change))
  const contact = t('mail.adminAccountChanged.contact')
  const footer = t('mail.footer', site)
  const list = style({ margin: '0 0 16px', padding: '0 0 0 24px' })
  const content = markup`<p style="${paragraph()}">${greeting}</p>
<p style="${paragraph({ margin: '0 0 8px' })}">${body}</p>
<ul style="${list}">${lines.map((line) => markup`<li style="${paragraph({ margin: '0 0 4px' })}">${line}</li>`)}</ul>
<p style="${paragraph({ margin: 0 })}">${contact}</p>`
  return {
    subject,
    html: layout({ locale: input.locale, subject, siteName: input.siteName, preview: body, content, footer }),
    text: [greeting, [body, ...lines.map((line) => `- ${line}`)].join('\n'), contact, footer].join('\n\n'),
  }
}

/** 后台的测试邮件：管理员确认 SMTP 设置能用（ADR-0028） */
export function renderTestEmail(input: NoticeMailInput): RenderedMail {
  const t = createTranslator(input.locale)
  const subject = t('mail.testEmail.subject', { siteName: input.siteName })
  const body = t('mail.testEmail.body')
  const greeting = t('mail.greeting', { nickname: input.nickname })
  const footer = t('mail.footer', { siteName: input.siteName })
  const content = markup`<p style="${paragraph()}">${greeting}</p>
<p style="${paragraph({ margin: 0 })}">${body}</p>`
  return {
    subject,
    html: layout({ locale: input.locale, subject, siteName: input.siteName, preview: body, content, footer }),
    text: [greeting, body, footer].join('\n\n'),
  }
}
