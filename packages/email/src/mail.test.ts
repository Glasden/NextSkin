import { describe, expect, test } from 'vitest'
import {
  renderResetPassword,
  renderVerifyEmail,
  renderConfirmEmailChange,
  renderEmailChanged,
  renderTestEmail,
  renderAdminAccountChanged,
  type AdminAccountChange,
} from './mail.ts'

const input = {
  locale: 'zh-CN' as const,
  siteName: '像素皮肤站',
  nickname: 'Steve',
  url: 'https://skin.example.com/api/auth/verify-email?token=abc&callbackURL=%2F',
  expiresInHours: 1,
}

describe('验证邮件', () => {
  test('主题、正文和链接', () => {
    const mail = renderVerifyEmail(input)
    expect(mail.subject).toBe('验证你在 像素皮肤站 的邮箱')
    expect(mail.html.startsWith('<!DOCTYPE html')).toBe(true)
    expect(mail.html).toContain('href="https://skin.example.com/api/auth/verify-email?token=abc&amp;callbackURL=%2F"')
    expect(mail.text).toContain(`验证邮箱：${input.url}`)
    expect(mail.text).toContain('1 小时内有效')
  })

  test('按收件人的语言渲染', () => {
    const mail = renderVerifyEmail({ ...input, locale: 'en', expiresInHours: 24 })
    expect(mail.subject).toBe('Verify your email for 像素皮肤站')
    expect(mail.text).toContain(`Verify email: ${input.url}`)
    expect(mail.text).toContain('24 hours')
    expect(mail.html).toContain('lang="en"')
  })

  test('昵称和站点名里的 HTML 会被转义', () => {
    const mail = renderVerifyEmail({ ...input, nickname: '<img src=x onerror=alert(1)>', siteName: 'A & B' })
    expect(mail.html).not.toContain('<img src=x')
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(mail.html).toContain('A &amp; B')
  })
})

test('重设密码邮件', () => {
  const mail = renderResetPassword(input)
  expect(mail.subject).toBe('重设你在 像素皮肤站 的密码')
  expect(mail.text).toContain(`重设密码：${input.url}`)
  expect(mail.text).toContain('你的密码不会改变')
})

describe('改邮箱邮件', () => {
  test.each(['zh-CN', 'en'] as const)('新地址确认邮件有链接、期限和登录/找回密码说明（%s）', (locale) => {
    const mail = renderConfirmEmailChange({ ...input, locale })
    expect(mail.html).toContain('href="https://skin.example.com/api/auth/verify-email?token=abc&amp;callbackURL=%2F"')
    expect(mail.text).toContain(input.url)
    expect(mail.html).toContain(`lang="${locale}"`)
    if (locale === 'zh-CN') {
      expect(mail.subject).toBe('确认你在 像素皮肤站 的新邮箱')
      expect(mail.text).toContain('登录和找回密码')
      expect(mail.text).toContain('1 小时内有效')
      expect(mail.text).toContain('忽略这封邮件')
    } else {
      expect(mail.subject).toBe('Confirm your new email for 像素皮肤站')
      expect(mail.text).toContain('sign in and reset your password')
      expect(mail.text).toContain('1 hour')
      expect(mail.text).toContain('ignore this email')
    }
  })
  test.each(['zh-CN', 'en'] as const)('旧地址通知不带链接或新地址，提示联系管理员（%s）', (locale) => {
    const mail = renderEmailChanged({ locale, siteName: input.siteName, nickname: '<b>Steve & Alex</b>' })
    expect(mail.html).not.toMatch(/<a\b|href=/)
    expect(mail.html).toContain('&lt;b&gt;Steve &amp; Alex&lt;/b&gt;')
    expect(mail.text).not.toMatch(/https?:\/\//)
    expect(mail.text).toContain(locale === 'zh-CN' ? '请联系站点管理员' : 'contact the site administrator')
    expect(mail.subject).toBe(
      locale === 'zh-CN' ? '你在 像素皮肤站 的账号邮箱已更改' : 'Your account email for 像素皮肤站 has changed',
    )
  })
})

test('测试邮件用收件人语言渲染并转义管理员内容，不带操作链接', () => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const mail = renderTestEmail({ locale, siteName: '<Test Site>', nickname: '<Admin>' })
    expect(mail.subject).toContain('<Test Site>')
    expect(mail.text).toContain('<Admin>')
    expect(mail.html).toContain(`lang="${locale}"`)
    expect(mail.html).toContain('&lt;Test Site&gt;')
    expect(mail.html).toContain('&lt;Admin&gt;')
    expect(mail.html).not.toMatch(/href=|<Admin>|<Test Site>/)
    expect(mail.text).toContain(locale === 'zh-CN' ? '邮件设置是对的' : 'mail settings of this site are correct')
  }
})

describe('管理员修改账号的通知', () => {
  const notice = {
    locale: 'zh-CN' as const,
    siteName: '像素皮肤站',
    nickname: 'Steve',
    at: '2026-10-19T06:30:00.000Z',
    timeZone: 'Asia/Shanghai',
  }
  const changes: AdminAccountChange[] = [
    { kind: 'email', pending: true },
    { kind: 'email', pending: false },
    { kind: 'password' },
    { kind: 'twoFactor' },
    { kind: 'passkeys', count: 1 },
    { kind: 'passkeys', count: 3 },
    { kind: 'binding', provider: 'GitHub' },
    { kind: 'playerRenamed', from: 'Steve', to: 'Alex' },
    { kind: 'playerDeleted', name: 'Herobrine' },
    { kind: 'playerTransferredOut', name: 'Notch' },
    { kind: 'playerTransferredIn', name: 'jeb_' },
  ]
  const items = (html: string) => [...html.matchAll(/<li\b[^>]*>(.*?)<\/li>/g)].map((match) => match[1])

  test.each([
    {
      locale: 'zh-CN' as const,
      subject: '管理员修改了你在 像素皮肤站 的账号',
      contact: '如果你不知道这次修改，请联系站点管理员。',
      lines: [
        '修改了你的邮箱（新地址确认之后才生效）',
        '修改了你的邮箱',
        '设置了新密码',
        '关闭了两步验证',
        '删除了 1 个通行密钥',
        '删除了 3 个通行密钥',
        '解除了 GitHub 账号的绑定',
        '把角色 Steve 改名为 Alex',
        '删除了角色 Herobrine',
        '把角色 Notch 转给了其他用户',
        '把角色 jeb_ 转给了你',
      ],
    },
    {
      locale: 'en' as const,
      subject: 'An administrator changed your 像素皮肤站 account',
      contact: "If you don't know about these changes, contact the site administrator.",
      lines: [
        'Changed your email address (takes effect once the new address is confirmed)',
        'Changed your email address',
        'Set a new password',
        'Turned off two-factor authentication',
        'Deleted 1 passkey',
        'Deleted 3 passkeys',
        'Unlinked your GitHub account',
        'Renamed your player Steve to Alex',
        'Deleted your player Herobrine',
        'Transferred your player Notch to another user',
        'Transferred the player jeb_ to you',
      ],
    },
  ])('每种修改各占一行，邮箱待确认时写明确认之后才生效（$locale）', ({ locale, subject, contact, lines }) => {
    const mail = renderAdminAccountChanged({ ...notice, locale, changes })
    expect(mail.subject).toBe(subject)
    expect(mail.html).toContain(`lang="${locale}"`)
    expect(items(mail.html)).toEqual(lines)
    expect(mail.text).toContain(lines.map((line) => `- ${line}`).join('\n'))
    expect(mail.text).toContain(contact)
    expect(mail.html).toContain(contact.replace("'", '&#39;'))
    // 不带链接：没有要收件人点的东西，有疑问就联系站点管理员
    expect(mail.html).not.toMatch(/<a\b|href=/)
    expect(mail.text).not.toMatch(/https?:\/\//)
  })

  test.each([
    { locale: 'zh-CN' as const, timeZone: 'Asia/Shanghai', at: notice.at, parts: ['2026年10月19日', '14:30', 'GMT+8'] },
    {
      locale: 'en' as const,
      timeZone: 'Asia/Shanghai',
      at: notice.at,
      parts: ['October 19, 2026', '2:30 PM', 'GMT+8'],
    },
    // 换算到站点时区之后日期也跟着变
    {
      locale: 'zh-CN' as const,
      timeZone: 'America/New_York',
      at: '2026-10-19T02:00:00.000Z',
      parts: ['2026年10月18日', '22:00', 'GMT-4'],
    },
    {
      locale: 'en' as const,
      timeZone: 'America/New_York',
      at: '2026-10-19T02:00:00.000Z',
      parts: ['October 18, 2026', '10:00 PM', 'GMT-4'],
    },
  ])('时间按收件人的语言和站点时区写出（$locale，$timeZone）', ({ locale, timeZone, at, parts }) => {
    const mail = renderAdminAccountChanged({ ...notice, locale, timeZone, at, changes: [{ kind: 'password' }] })
    // 有的 ICU 版本在时间和 AM/PM 之间用窄的不换行空格
    const body = mail.text.split('\n\n')[1]!.replace(/\s/g, ' ')
    const html = mail.html.replace(/\s/g, ' ')
    for (const part of parts) {
      expect(body).toContain(part)
      expect(html).toContain(part)
    }
  })

  test('昵称、站点名、第三方名称和角色名在 HTML 里都被转义，纯文字版原样输出', () => {
    const mail = renderAdminAccountChanged({
      ...notice,
      siteName: 'A & B',
      nickname: '<b>Steve</b>',
      changes: [
        { kind: 'binding', provider: '<GitHub>' },
        { kind: 'playerRenamed', from: '<i>a</i>', to: 'b&c' },
        { kind: 'playerDeleted', name: '<script>' },
        { kind: 'playerTransferredOut', name: "<u>o'k</u>" },
        { kind: 'playerTransferredIn', name: '<s>in</s>' },
      ],
    })
    expect(mail.html).not.toMatch(/<b>|<x>|<GitHub>|<i>|<script>|<u>|<s>/)
    expect(mail.html).toContain('&lt;b&gt;Steve&lt;/b&gt;')
    expect(mail.html).toContain('A &amp; B')
    expect(items(mail.html)).toEqual([
      '解除了 &lt;GitHub&gt; 账号的绑定',
      '把角色 &lt;i&gt;a&lt;/i&gt; 改名为 b&amp;c',
      '删除了角色 &lt;script&gt;',
      '把角色 &lt;u&gt;o&#39;k&lt;/u&gt; 转给了其他用户',
      '把角色 &lt;s&gt;in&lt;/s&gt; 转给了你',
    ])
    expect(mail.subject).toBe('管理员修改了你在 A & B 的账号')
    expect(mail.text).toContain('<b>Steve</b>，你好：')
    expect(mail.text).toContain('- 解除了 <GitHub> 账号的绑定')
    expect(mail.text).toContain("- 把角色 <u>o'k</u> 转给了其他用户")
  })
})
