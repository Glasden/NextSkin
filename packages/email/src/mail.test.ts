import { describe, expect, test } from 'vitest'
import { renderResetPassword, renderVerifyEmail } from './mail.ts'

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
