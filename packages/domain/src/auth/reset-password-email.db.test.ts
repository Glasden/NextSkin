/**
 * 找回密码的发信回调和改邮箱交错（ADR-0036"作废在途的登录"第二段）。Better Auth 先按邮箱查出用户、再写入记录、
 * 最后调发信回调，都不加锁；改邮箱的事务删完找回链接、还没提交时写入的记录删不到。回调锁住用户行之后重读邮箱，
 * 读到新邮箱就删掉这条记录、不发信
 */
import { dialectOf } from '@nextskin/db'
import { beforeEach, expect, test, vi } from 'vitest'
import { setup } from '../closet/test-support.ts'

const env = setup()
const ROOT = 'http://localhost:3000'
const oldEmail = 'target@example.test'
const newEmail = 'new@example.test'
const newPassword = 'a brand new long password'
let admin: { uid: number; ip: string }
let target: { uid: number }

beforeEach(async () => {
  await env.db().deleteFrom('verifications').execute()
  await env.setting('mail.transport', 'smtp')
  await env.setting('mail.from', { address: 'sender@example.test', name: 'NextSkin' })
  admin = { uid: (await env.user('admin')).uid, ip: '192.0.2.1' }
  await env.db().updateTable('users').set({ role: 'superadmin' }).where('id', '=', admin.uid).execute()
  target = await env.user('target')
})

async function auth(path: string, body: unknown) {
  const response = await env.core.auth.handle(
    new Request(ROOT + '/api/auth' + path, {
      method: 'POST',
      headers: { origin: ROOT, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ROOT,
    '127.0.0.1',
  )
  return { status: response.status, body: (await response.json()) as { code?: string } }
}
const requestReset = (email: string) => auth('/request-password-reset', { email, redirectTo: `${ROOT}/reset-password` })
const resetWith = (token: string) => auth('/reset-password', { token, newPassword })

/** 这个用户还在的找回链接（标识 `reset-password:<令牌>`，值是 uid） */
async function resetLinks() {
  const rows = await env
    .db()
    .selectFrom('verifications')
    .select('identifier')
    .where('identifier', 'like', 'reset-password:%')
    .where('value', '=', String(target.uid))
    .execute()
  return rows.map((row) => row.identifier.slice('reset-password:'.length))
}
async function mails(template: string) {
  const rows = await env.db().selectFrom('jobs').select('payload').where('name', '=', 'core:mail').execute()
  return rows
    .map((row) => JSON.parse(row.payload) as { template: string; to: string; url?: string })
    .filter((mail) => mail.template === template)
}
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时')
}

/** 两种让新邮箱生效的事务：后台收回账号时立即换邮箱；后台发起改邮箱之后，用户点确认链接 */
const changes = {
  reclaim: () =>
    Promise.resolve(() => env.core.admin.setUserPassword(admin, target.uid, { password: newPassword, newEmail })),
  confirm: async () => {
    expect(await env.core.admin.changeUserEmail(admin, target.uid, { email: newEmail }, ROOT)).toEqual({
      status: 'pending',
      pendingEmail: newEmail,
    })
    const [mail] = await mails('confirmEmailChange')
    const token = new URL(mail!.url!).searchParams.get('token')!
    return () => env.core.users.confirmEmailChange(token)
  },
}

test.each(['reclaim', 'confirm'] as const)(
  '改邮箱（%s）和找回密码交错：记录写在删除之后、提交之前，发到旧地址的找回链接也都失效',
  async (kind) => {
    // 改邮箱之前就发出的链接：由改邮箱的事务删掉
    expect((await requestReset(oldEmail)).status).toBe(200)
    const before = await resetLinks()
    expect(before).toHaveLength(1)
    const change = await changes[kind]()
    const pause = env.pauseNextCommit()
    let interleaved: string[] = []
    try {
      const changing = change()
      // 改邮箱的事务已经删完找回链接，停在提交之前（事务自己出错时直接失败，不干等）
      await Promise.race([pause.entered, changing])
      const requesting = requestReset(oldEmail)
      try {
        // MySQL 和 PostgreSQL 上，Better Auth 按旧邮箱查到用户、写入新记录，回调排在用户行锁上。
        // SQLite 只有一个连接，请求排在改邮箱的事务后面，查用户时已经是新邮箱，不会写入记录
        if (dialectOf(env.db()) !== 'sqlite')
          await eventually(async () => {
            interleaved = (await resetLinks()).filter((token) => !before.includes(token))
            return interleaved.length > 0
          })
      } finally {
        pause.resume()
      }
      await changing
      expect((await requesting).status).toBe(200)
    } finally {
      pause.restore()
    }
    expect(await resetLinks()).toEqual([])
    for (const token of [...before, ...interleaved])
      expect(await resetWith(token)).toMatchObject({ status: 400, body: { code: 'INVALID_TOKEN' } })
    // 交错的那个请求没有发信：只有改邮箱之前入队的一封
    expect((await mails('resetPassword')).map((mail) => mail.to)).toEqual([oldEmail])
    // 新地址照常能找回：邮箱对得上时，回调在锁内入队
    expect((await requestReset(newEmail)).status).toBe(200)
    expect((await mails('resetPassword')).map((mail) => mail.to)).toEqual([oldEmail, newEmail])
    const [token] = await resetLinks()
    expect((await resetWith(token!)).status).toBe(200)
  },
)

test('邮箱在 Better Auth 查出用户之后、发信之前换掉：回调删掉这条记录、不发信', async () => {
  const configured = env.core.mail.configured
  let changed = false
  // 回调开头先确认配置了邮件，这时记录已经写入；在这里换掉邮箱，造出"查用户之后、回调之前"的改动
  const spy = vi.spyOn(env.core.mail, 'configured').mockImplementation(async () => {
    if (!changed && (await resetLinks()).length > 0) {
      changed = true
      await env.db().updateTable('users').set({ email: newEmail }).where('id', '=', target.uid).execute()
    }
    return configured()
  })
  try {
    expect((await requestReset(oldEmail)).status).toBe(200)
  } finally {
    spy.mockRestore()
  }
  expect(changed).toBe(true)
  expect(await resetLinks()).toEqual([])
  expect(await mails('resetPassword')).toEqual([])
})
