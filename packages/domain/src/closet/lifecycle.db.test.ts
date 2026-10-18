import { expect, test } from 'vitest'
import { setup, old } from './test-support.ts'

const env = setup()

test('加入、改名、按实付退还，清理两个角色槽位，头像保留，事件与流水同事务', async () => {
  const { core, actor } = env
  const tid = await env.texture()
  await env.setting('score.perClosetItem', 7)
  env.subscribe('closet.itemAdded', 'closet.itemRemoved', 'player.texturesChanged', 'user.profileUpdated')
  const item = await core.closet.add(actor, { tid, name: ' Mine ' })
  expect(item).toMatchObject({
    tid,
    name: 'Mine',
    textureName: 'Texture',
    type: 'steve',
    public: true,
    scale: 1,
    scorePaid: 7,
    addedAt: env.now(),
  })
  expect(await core.closet.rename(actor, tid, { name: ' New ' })).toMatchObject({
    name: 'New',
    textureName: 'Texture',
    scorePaid: 7,
    addedAt: item.addedAt,
  })
  expect(await core.textures.detail(actor.uid, tid)).toMatchObject({
    closetItem: { name: 'New', scorePaid: 7 },
    reported: false,
  })
  expect(await core.textures.detail(null, tid)).toMatchObject({ closetItem: null, reported: false })
  const player = await core.players.create(actor, { name: 'Player' })
  await core.players.update(actor, player.pid, { skin: tid })
  await core.users.updateProfile(actor, { avatar: tid })
  // 模拟导入的错槽位；移出也必须清掉披风槽。
  await env
    .db()
    .updateTable('players')
    .set({ cape_texture_id: tid, updated_at: old })
    .where('id', '=', player.pid)
    .execute()
  await env.setting('score.perClosetItem', 99)
  env.tick()
  expect(await core.closet.remove(actor, tid)).toEqual({ refunded: 7 })
  expect(await env.balance()).toBe(1000)
  expect(
    await env
      .db()
      .selectFrom('players')
      .select(['skin_texture_id', 'cape_texture_id', 'updated_at'])
      .where('id', '=', player.pid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ skin_texture_id: null, cape_texture_id: null, updated_at: env.now() })
  expect(await core.users.avatar(actor.uid)).toMatchObject({ tid, scale: 1 })
  expect(await env.events('closet.itemAdded')).toEqual([
    expect.objectContaining({ actor: { kind: 'user', uid: actor.uid, role: 'user' }, data: { uid: actor.uid, tid } }),
  ])
  expect((await env.events('closet.itemRemoved'))[0]?.data).toEqual({ uid: actor.uid, tid })
  expect((await env.events('player.texturesChanged')).at(-1)?.data).toMatchObject({
    previous: { skin: tid, cape: tid },
    player: { skin: null, cape: null, updatedAt: env.now() },
  })
  expect(await env.events('user.profileUpdated')).toHaveLength(1)
  expect(await env.ledger()).toEqual([
    {
      delta: -7,
      reason: 'score.reasons.closetItemAdded',
      subject_type: 'texture',
      subject_id: tid,
      created_at: item.addedAt,
    },
    {
      delta: 7,
      reason: 'score.reasons.closetItemRemoved',
      subject_type: 'texture',
      subject_id: tid,
      created_at: env.now(),
    },
  ])
  await env.consistent(tid)
})

test('关掉退还时不退；零费用不写积分流水；默认名字不重新验证', async () => {
  const { core, actor } = env
  const tid = await env.texture('steve', true, '旧名字')
  await env.setting('texture.nameRegex', '^New$')
  await env.setting('score.perClosetItem', 8)
  expect(await core.closet.add(actor, { tid })).toMatchObject({ name: '旧名字' })
  await env.setting('score.refundOnDelete', false)
  expect(await core.closet.remove(actor, tid)).toEqual({ refunded: 0 })
  expect(await env.balance()).toBe(992)
  await env.setting('score.perClosetItem', 0)
  await core.closet.add(actor, { tid })
  expect(await core.closet.remove(actor, tid)).toEqual({ refunded: 0 })
  expect(await env.ledger()).toHaveLength(1)
  await env.consistent(tid)
})

test('衣柜错误、隐藏私有材质、名字验证和余额不足全部回滚', async () => {
  const { core, actor, owner } = env
  const tid = await env.texture()
  const hidden = await env.texture('steve', false)
  await expect(core.closet.add(actor, { tid: hidden })).rejects.toMatchObject({ code: 'texture_not_found' })
  await expect(core.closet.add(actor, { tid: 2147483647 })).rejects.toMatchObject({ code: 'texture_not_found' })
  await core.closet.add(owner, { tid: hidden })
  for (const operation of [
    () => core.closet.rename(actor, tid, { name: 'Name' }),
    () => core.closet.remove(actor, tid),
  ])
    await expect(operation()).rejects.toMatchObject({ code: 'closet_item_not_found' })
  await expect(core.closet.add(actor, { tid, name: ' ' })).rejects.toMatchObject({ code: 'texture_name_length' })
  await env.setting('texture.nameRegex', '^Good$')
  await expect(core.closet.add(actor, { tid, name: 'Bad' })).rejects.toMatchObject({ code: 'texture_name_invalid' })
  await core.closet.add(actor, { tid })
  await expect(core.closet.rename(actor, tid, { name: 'Bad' })).rejects.toMatchObject({ code: 'texture_name_invalid' })
  await env.setting('texture.nameRegex', '[')
  await expect(core.closet.rename(actor, tid, { name: 'Good' })).rejects.toMatchObject({
    code: 'texture_name_rule_misconfigured',
  })
  await expect(core.closet.add(actor, { tid })).rejects.toMatchObject({ code: 'closet_item_exists' })
  await core.closet.remove(actor, tid)
  await env.setting('score.perClosetItem', 1001)
  env.subscribe('closet.itemAdded')
  await expect(core.closet.add(actor, { tid })).rejects.toMatchObject({ code: 'score_insufficient' })
  expect(await env.events('closet.itemAdded')).toEqual([])
  expect(await env.balance()).toBe(1000)
  await env.consistent(tid)
})

test('列表按衣柜名搜索、类型过滤、时间和 tid 倒序；分页限幅；不合法旧尺寸回退到 1', async () => {
  const { core, actor } = env
  const first = await env.texture('steve', true, 'Unrelated')
  const second = await env.texture('alex')
  const cape = await env.texture('cape')
  await core.closet.add(actor, { tid: first, name: 'MiNe%_' })
  await core.closet.add(actor, { tid: second, name: 'mine two' })
  await core.closet.add(actor, { tid: cape, name: 'mine cape' })
  expect(
    (await core.closet.list(actor.uid, { type: 'skin', q: 'MINE', page: 0, perPage: 0 })).items.map((i) => i.tid),
  ).toEqual([second])
  expect(
    (await core.closet.list(actor.uid, { type: 'skin', q: 'mine', page: 2, perPage: 1 })).items.map((i) => i.tid),
  ).toEqual([first])
  expect(await core.closet.list(actor.uid, { type: 'skin', q: '%_', page: 1 })).toMatchObject({
    total: 1,
    items: [{ tid: first }],
  })
  expect(await core.closet.list(actor.uid, { type: 'cape', page: 1, perPage: 100 })).toMatchObject({
    total: 1,
    items: [{ tid: cape }],
  })
  await env
    .db()
    .updateTable('texture_files')
    .set({ width: 1 })
    .where('hash', '=', (await core.closet.list(actor.uid, { type: 'skin', page: 1 })).items[0]!.hash)
    .execute()
  expect((await core.closet.list(actor.uid, { type: 'skin', page: 1 })).items[0]?.scale).toBe(1)
  env.tick()
  await core.closet.remove(actor, first)
  await core.closet.add(actor, { tid: first })
  expect((await core.closet.list(actor.uid, { type: 'skin', page: 1 })).items.map((i) => i.tid)).toEqual([
    first,
    second,
  ])
})

test('并发加入、移出，收藏数等于条数；同人同时加入只扣一次', async () => {
  const { core, actor } = env
  const tid = await env.texture()
  await env.setting('score.perClosetItem', 9)
  env.subscribe('closet.itemAdded')
  const results = await Promise.allSettled([core.closet.add(actor, { tid }), core.closet.add(actor, { tid })])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'closet_item_exists' } }])
  expect(await env.balance()).toBe(991)
  expect(await env.events('closet.itemAdded')).toHaveLength(1)
  expect(await env.ledger()).toHaveLength(1)
  const others = await Promise.all([env.user('one'), env.user('two'), env.user('three')])
  await Promise.all(others.map((user) => core.closet.add(user, { tid })))
  await env.consistent(tid)
  await Promise.all([
    core.closet.remove(actor, tid),
    core.closet.remove(others[0], tid),
    core.closet.add(await env.user('four'), { tid }),
  ])
  await env.consistent(tid)
  const removed = await Promise.allSettled([core.closet.remove(others[1], tid), core.closet.remove(others[1], tid)])
  expect(removed.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(removed.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'closet_item_not_found' } }])
  await env.consistent(tid)
})

test('合并改名和换材质，双事件带最终角色；无变化不写库不发事件，UUID 不变', async () => {
  const { core, actor } = env
  const skin = await env.texture(),
    cape = await env.texture('cape')
  await core.closet.add(actor, { tid: skin })
  await core.closet.add(actor, { tid: cape })
  const player = await core.players.create(actor, { name: 'Before' })
  env.subscribe('player.renamed', 'player.texturesChanged')
  const changed = await core.players.update(actor, player.pid, { name: 'After', skin, cape })
  expect(changed).toMatchObject({ name: 'After', skin, cape, uuid: player.uuid, updatedAt: env.now() })
  expect((await env.events('player.renamed'))[0]?.data).toEqual({ player: changed, previousName: 'Before' })
  expect((await env.events('player.texturesChanged'))[0]?.data).toEqual({
    player: changed,
    previous: { skin: null, cape: null },
  })
  env.tick()
  const writes = env.playerWrites
  expect(await core.players.update(actor, player.pid, { name: 'After', skin, cape })).toEqual(changed)
  // user 和 texture 的锁是 UPDATE；角色本身不应再写。
  expect(env.playerWrites).toBe(writes)
  expect(await env.events('player.renamed')).toHaveLength(1)
  expect(await env.events('player.texturesChanged')).toHaveLength(1)
  expect(await core.players.update(actor, player.pid, { skin: null, cape: null })).toMatchObject({
    skin: null,
    cape: null,
    updatedAt: env.now(),
  })
})

test('换材质按可见性、衣柜、槽位顺序验证；失败不会连带改名', async () => {
  const { core, actor } = env
  const skin = await env.texture(),
    cape = await env.texture('cape'),
    hidden = await env.texture('steve', false)
  const player = await core.players.create(actor, { name: 'Before' })
  await expect(core.players.update(actor, player.pid, { name: 'After', skin: hidden })).rejects.toMatchObject({
    code: 'texture_not_found',
  })
  await expect(core.players.update(actor, player.pid, { skin })).rejects.toMatchObject({
    code: 'closet_item_not_found',
  })
  await core.closet.add(actor, { tid: skin })
  await core.closet.add(actor, { tid: cape })
  await expect(core.players.update(actor, player.pid, { skin: cape })).rejects.toMatchObject({
    code: 'texture_type_mismatch',
    params: { slot: 'skin' },
  })
  await expect(core.players.update(actor, player.pid, { cape: skin })).rejects.toMatchObject({
    code: 'texture_type_mismatch',
    params: { slot: 'cape' },
  })
  // 两个槽一起给时按整个请求排优先级：较小 tid 的类型不符，也先报较大 tid 的不可见、不在衣柜
  const outside = await env.texture()
  await expect(core.players.update(actor, player.pid, { skin: cape, cape: hidden })).rejects.toMatchObject({
    code: 'texture_not_found',
  })
  await expect(core.players.update(actor, player.pid, { skin: cape, cape: outside })).rejects.toMatchObject({
    code: 'closet_item_not_found',
  })
  expect(await core.players.update(actor, player.pid, {})).toMatchObject({ name: 'Before', skin: null, cape: null })
  await expect(core.players.update(env.owner, player.pid, { skin })).rejects.toMatchObject({ code: 'player_not_found' })
})

test('邮箱开关对换材质生效，加入衣柜和头像不要求验证；封禁用户所有写操作被拒', async () => {
  const { core, actor } = env
  const tid = await env.texture()
  const player = await core.players.create(actor, { name: 'Player' })
  await env.db().updateTable('users').set({ email_verified: false }).where('id', '=', actor.uid).execute()
  await env.setting('auth.requireEmailVerification', true)
  await core.closet.add(actor, { tid })
  await core.closet.rename(actor, tid, { name: 'Name' })
  await core.users.updateProfile(actor, { avatar: tid })
  await expect(core.players.update(actor, player.pid, { skin: tid })).rejects.toMatchObject({
    code: 'email_not_verified',
  })
  await env.setting('auth.requireEmailVerification', false)
  await core.players.update(actor, player.pid, { skin: tid })
  await env.db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  for (const operation of [
    () => core.closet.add(actor, { tid }),
    () => core.closet.rename(actor, tid, { name: 'Name' }),
    () => core.closet.remove(actor, tid),
    () => core.players.update(actor, player.pid, { skin: null }),
    () => core.users.updateProfile(actor, { avatar: null }),
  ])
    await expect(operation()).rejects.toMatchObject({ code: 'user_banned' })
})

test('头像不要求在衣柜，只接受可见皮肤；合并资料字段只发一次事件，清除和旧尺寸', async () => {
  const { core, actor, owner } = env
  const tid = await env.texture(),
    cape = await env.texture('cape'),
    hidden = await env.texture('steve', false)
  env.subscribe('user.profileUpdated')
  expect(await core.users.avatar(actor.uid)).toBeNull()
  await expect(core.users.updateProfile(actor, { avatar: hidden })).rejects.toMatchObject({ code: 'texture_not_found' })
  await expect(core.users.updateProfile(actor, { avatar: 2147483647 })).rejects.toMatchObject({
    code: 'texture_not_found',
  })
  await expect(core.users.updateProfile(actor, { avatar: cape })).rejects.toMatchObject({
    code: 'texture_type_mismatch',
    params: { slot: 'avatar' },
  })
  expect(await core.users.updateProfile(actor, { nickname: 'New', locale: 'en', avatar: tid })).toMatchObject({
    nickname: 'New',
    locale: 'en',
    avatarTid: tid,
  })
  const events = await env.events('user.profileUpdated')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    actor: { kind: 'user', uid: actor.uid, role: 'user' },
    data: { uid: actor.uid, fields: ['avatar', 'nickname', 'locale'] },
  })
  const avatar = await core.users.avatar(actor.uid)
  expect(avatar).toMatchObject({ tid, scale: 1 })
  await core.users.updateProfile(actor, { avatar: tid })
  expect(await env.events('user.profileUpdated')).toHaveLength(1)
  await env.db().updateTable('texture_files').set({ width: 1 }).where('hash', '=', avatar!.hash).execute()
  expect(await core.users.avatar(actor.uid)).toBeNull()
  await core.users.updateProfile(actor, { avatar: null })
  expect(await core.users.avatar(actor.uid)).toBeNull()
  await core.users.updateProfile(owner, { avatar: hidden })
  expect(await core.users.avatar(owner.uid)).toMatchObject({ tid: hidden })
})

test.each(['equip', 'private'] as const)('改私有与换材质并发：%s 先拿锁', async (first) => {
  const { core, actor, owner } = env
  const tid = await env.texture()
  await core.closet.add(actor, { tid })
  const player = await core.players.create(actor, { name: 'Player' })
  env.subscribe('player.texturesChanged')
  const equip = () => core.players.update(actor, player.pid, { skin: tid })
  const hide = () => core.textures.update(owner, tid, { public: false })
  const pause = env.pauseNextCommit()
  const leading = (first === 'equip' ? equip() : hide()).then(
    (value) => value,
    (error: unknown) => error,
  )
  let trailing: Promise<unknown> | undefined
  try {
    await pause.entered
    trailing = (first === 'equip' ? hide() : equip()).then(
      (value) => value,
      (error: unknown) => error,
    )
    await pause.contended
    pause.resume()
    await leading
    const result = await trailing
    if (first === 'private') expect(result).toMatchObject({ code: 'texture_not_found' })
    else expect(result).toMatchObject({ texture: { public: false } })
    const stored = await env
      .db()
      .selectFrom('players')
      .select('skin_texture_id')
      .where('id', '=', player.pid)
      .executeTakeFirstOrThrow()
    expect(stored.skin_texture_id).toBeNull()
    expect((await core.closet.list(actor.uid, { type: 'skin', page: 1 })).total).toBe(0)
    expect(await env.events('player.texturesChanged')).toHaveLength(first === 'equip' ? 2 : 0)
    await env.consistent(tid)
  } finally {
    pause.resume()
    await leading
    await trailing
    pause.restore()
  }
})
