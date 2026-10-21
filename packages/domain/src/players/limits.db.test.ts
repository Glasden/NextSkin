import { countRows, type UserRole } from '@nextskin/db'
import { expect, test } from 'vitest'
import { setup } from '../closet/test-support.ts'

const env = setup()
const create = (name: string) => env.core.players.create(env.actor, { name })
const players = () =>
  env.db().selectFrom('players').selectAll().where('user_id', '=', env.actor.uid).orderBy('id').execute()
async function snapshot() {
  return {
    players: await players(),
    balance: await env.balance(),
    ledger: await env.ledger(),
    jobs: await env.db().selectFrom('jobs').selectAll().orderBy('id').execute(),
  }
}

test('达到上限后不再添加，角色、积分、流水和事件均不变；删掉一个后又能加', async () => {
  await env.setting('player.maxPerUser', 1)
  await env.setting('score.perPlayer', 100)
  env.subscribe('player.created')
  const first = await create('First')
  const before = await snapshot()
  await expect(create('Second')).rejects.toMatchObject({ code: 'player_limit_reached', params: { limit: 1 } })
  expect(await snapshot()).toEqual(before)
  await env.core.players.delete(env.actor, first.pid)
  await expect(create('Second')).resolves.toMatchObject({ name: 'Second' })
  expect(await players()).toHaveLength(1)
})

test('上限为 0 时不限；调低上限保留已有角色，只禁止继续添加', async () => {
  await env.setting('player.maxPerUser', 0)
  await create('First')
  await create('Second')
  await env.setting('player.maxPerUser', 1)
  const before = await snapshot()
  await expect(create('Third')).rejects.toMatchObject({ code: 'player_limit_reached', params: { limit: 1 } })
  expect(await snapshot()).toEqual(before)
  expect(await players()).toHaveLength(2)
})

test.each<UserRole>(['admin', 'superadmin'])('%s 添加角色不受数量上限限制', async (role) => {
  await env.db().updateTable('users').set({ role }).where('id', '=', env.actor.uid).execute()
  await env.setting('player.maxPerUser', 1)
  await create('First')
  await create('Second')
  expect(await players()).toHaveLength(2)
})

test('并发添加共用用户锁，只有一个请求能占到最后一个名额', async () => {
  await env.setting('player.maxPerUser', 1)
  await env.setting('score.perPlayer', 100)
  const results = await Promise.allSettled([create('First'), create('Second')])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
    { reason: { code: 'player_limit_reached', params: { limit: 1 } } },
  ])
  expect(await countRows(env.db().selectFrom('players').where('user_id', '=', env.actor.uid))).toBe(1)
  expect(await env.balance()).toBe(900)
  expect(await env.ledger()).toHaveLength(1)
})

test('封禁和邮箱验证先于数量上限，上限先于名字和积分检查', async () => {
  await create('First')
  await env.setting('player.maxPerUser', 1)
  await env.setting('score.perPlayer', 1001)
  const before = await snapshot()
  for (const name of ['First', 'a', 'Bad Name'])
    await expect(create(name)).rejects.toMatchObject({ code: 'player_limit_reached', params: { limit: 1 } })
  expect(await snapshot()).toEqual(before)
  await env
    .db()
    .updateTable('users')
    .set({ role: 'banned', email_verified: false })
    .where('id', '=', env.actor.uid)
    .execute()
  await env.setting('auth.requireEmailVerification', true)
  await expect(create('Second')).rejects.toMatchObject({ code: 'user_banned' })
  await env.db().updateTable('users').set({ role: 'user' }).where('id', '=', env.actor.uid).execute()
  await expect(create('Second')).rejects.toMatchObject({ code: 'email_not_verified' })
})
