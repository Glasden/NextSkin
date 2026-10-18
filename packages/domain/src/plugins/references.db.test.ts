import { expect, test } from 'vitest'
import { pluginEnvironment } from './plugins.test-helper.ts'
import { pluginReferences } from './references.ts'

const env = pluginEnvironment()

test('按 id 查出昵称和角色名；数字字符串也认，查不到和不像 id 的值跳过', async () => {
  await env.boot([])
  const input = env.input()
  const { uid } = await env.core.users.register(input)
  const { id: pid } = await env.db
    .selectFrom('players')
    .select('id')
    .where('user_id', '=', uid)
    .executeTakeFirstOrThrow()

  const references = await pluginReferences(env.db, {
    uids: [uid, String(uid), 999_999, '0', '-1', '1.5', 'abc', null, { uid }],
    pids: [String(pid), 999_999, true],
  })
  expect(references).toEqual({
    users: { [uid]: { nickname: input.playerName, avatar: null } },
    players: { [pid]: { name: input.playerName } },
  })
})

test('没有 id 时不查库', async () => {
  expect(await pluginReferences(env.db, { uids: [], pids: ['x'] })).toEqual({ users: {}, players: {} })
})
