import { describe, expect, test } from 'vitest'
import {
  renderResetPassword,
  renderVerifyEmail,
  renderConfirmEmailChange,
  renderEmailChanged,
  renderTestEmail,
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
