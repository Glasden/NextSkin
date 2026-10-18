import {
  coreMigrations,
  countRows,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  transactionWithRetry,
  upsert,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import type { EventEnvelope, EventName, UserRole } from '@nextskin/plugin-sdk'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createCore, encodeSettingValue, type Core, type CoreSettingKey, type CoreSettingValue } from '../index.ts'
import { offlineUuid } from '../players/create.ts'
import { missUuidPrecheckOnce } from '../players/uuid-race.test-helper.ts'
import { adjustScore } from '../score/adjust.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const old = toIsoTimestamp(new Date('2020-01-01T00:00:00Z'))
let database: TestDatabase<CoreDatabase>
let core: Core
let actor: { uid: number }
const db = () => database.db
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('users').execute()
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('settings').execute()
  core = createCore({
    db: db(),
    secretKey,
    production: false,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  actor = await user('owner')
})
async function user(name: string, score = 1000, role: UserRole = 'user', verified = true) {
  const uid = await insertReturningId(db(), 'users', {
    nickname: name,
    email: `${name}@example.test`,
    role,
    email_verified: verified,
    created_at: writeAuthDate(db(), old),
    updated_at: writeAuthDate(db(), old),
  })
  if (score > 0)
    await transactionWithRetry(db(), (tx) =>
      adjustScore(tx, { uid, delta: score, reason: 'score.reasons.initial', now: old }),
    )
  return { uid }
}
async function setting<K extends CoreSettingKey>(key: K, value: CoreSettingValue<K>) {
  await upsert(db(), 'settings', {
    values: { namespace: 'core', key, value: encodeSettingValue(key, value, { secretKey }), updated_at: old },
    conflict: ['namespace', 'key'],
    update: ['value', 'updated_at'],
  })
}
const create = (name = 'Steve') => core.players.create(actor, { name })
const row = (pid: number) => db().selectFrom('players').selectAll().where('id', '=', pid).executeTakeFirstOrThrow()
const ledger = () =>
  db().selectFrom('score_transactions').selectAll().where('user_id', '=', actor.uid).orderBy('id').execute()
const balance = async () => (await core.users.overview(actor.uid))!.score
function subscribe<E extends EventName>(name: E) {
  const events: EventEnvelope<E>[] = []
  core.events.subscribe(name, `test:${name}`, {
    run: ({ event }) => {
      events.push(event)
      return Promise.resolve()
    },
  })
  return events
}
function oneFailure(results: PromiseSettledResult<unknown>[], code: string) {
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([
    { status: 'rejected', reason: { name: 'DomainError', code } },
  ])
}

test('添加扣分、记录实付和流水；提交后投递完整事件信封', async () => {
  const events = subscribe('player.created')
  const player = await create(' Steve ')
  expect(player).toEqual({
    pid: expect.any(Number) as unknown,
    uid: actor.uid,
    name: 'Steve',
    uuid: expect.stringMatching(/^[a-f0-9]{32}$/) as unknown,
    skin: null,
    cape: null,
    updatedAt: expect.any(String) as unknown,
  })
  expect(await row(player.pid)).toMatchObject({
    score_paid: 100,
    created_at: player.updatedAt,
    updated_at: player.updatedAt,
  })
  expect(await balance()).toBe(900)
  expect((await ledger()).at(-1)).toMatchObject({
    delta: -100,
    balance: 900,
    reason: 'score.reasons.playerCreated',
    subject_type: 'player',
    subject_id: player.pid,
    created_at: player.updatedAt,
  })
  expect(events).toEqual([])
  await core.jobs.drain()
  expect(events).toEqual([
    {
      id: expect.any(String) as unknown,
      name: 'player.created',
      occurredAt: player.updatedAt,
      actor: { kind: 'user', uid: actor.uid, role: 'user' },
      data: { player },
    },
  ])
})

test('免费角色不写流水；余额不足时角色、积分、任务全部回滚', async () => {
  const events = subscribe('player.created')
  await setting('score.perPlayer', 0)
  const free = await create()
  expect((await row(free.pid)).score_paid).toBe(0)
  expect(await ledger()).toHaveLength(1)
  await setting('score.perPlayer', 1001)
  const before = await ledger()
  await expect(create('Other')).rejects.toMatchObject({
    code: 'score_insufficient',
    params: { required: 1001, balance: 1000 },
  })
  expect(await countRows(db().selectFrom('players'))).toBe(1)
  expect(await ledger()).toEqual(before)
  expect(await balance()).toBe(1000)
  await core.jobs.drain()
  expect(events).toHaveLength(1)
})

test('离线 UUID 在预查之后才被改名的角色占上：整个用例重来一次，改用随机 UUID，只扣一次分', async () => {
  const other = await user('other')
  // 别人的角色原来叫 Steve，改名后保留了 Steve 的离线 UUID
  await db()
    .insertInto('players')
    .values({
      user_id: other.uid,
      name: 'Alex',
      name_key: 'alex',
      uuid: offlineUuid('Steve'),
      skin_texture_id: null,
      cape_texture_id: null,
      created_at: old,
      updated_at: old,
    })
    .execute()
  core = createCore({
    db: db().withPlugin(missUuidPrecheckOnce()),
    secretKey,
    production: false,
    textureStorage: {
      list: () => Promise.resolve([]),
      listTemp: () => Promise.resolve([]),
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  const player = await create('Steve')
  expect(player.uuid).toMatch(/^[0-9a-f]{32}$/)
  expect(player.uuid).not.toBe(offlineUuid('Steve'))
  expect(await balance()).toBe(900)
  expect(await ledger()).toHaveLength(2)
})

test('名字规则与占用冲突复用注册规则', async () => {
  for (const [name, code] of [
    ['ab', 'player_name_length'],
    ['bad name', 'player_name_invalid'],
  ] as const)
    await expect(create(name)).rejects.toMatchObject({ code })
  await create()
  await expect(create('sTEve')).rejects.toMatchObject({ code: 'player_name_taken' })
  expect(await balance()).toBe(900)
})

test.each(['create', 'rename', 'delete'] as const)('%s 拒绝封禁、未验证和不存在的用户', async (operation) => {
  const player = await create()
  const call = (a = actor) =>
    operation === 'create'
      ? core.players.create(a, { name: 'Other' })
      : operation === 'rename'
        ? core.players.update(a, player.pid, { name: 'Other' })
        : core.players.delete(a, player.pid)
  await expect(call({ uid: 2147483647 })).rejects.toMatchObject({ code: 'unauthenticated' })
  await setting('auth.requireEmailVerification', true)
  await db().updateTable('users').set({ role: 'banned', email_verified: false }).where('id', '=', actor.uid).execute()
  await expect(call()).rejects.toMatchObject({ code: 'user_banned' })
  await db().updateTable('users').set({ role: 'user' }).where('id', '=', actor.uid).execute()
  await expect(call()).rejects.toMatchObject({ code: 'email_not_verified' })
  expect((await row(player.pid)).name).toBe('Steve')
  expect(await balance()).toBe(900)
})

test('改名保留 UUID，更新时间；同名不写库、不发事件，只改大小写可成功', async () => {
  const events = subscribe('player.renamed')
  const player = await create()
  await db().updateTable('players').set({ updated_at: old }).where('id', '=', player.pid).execute()
  expect(await core.players.update(actor, player.pid, { name: 'Steve' })).toEqual({ ...player, updatedAt: old })
  expect((await row(player.pid)).updated_at).toBe(old)
  expect(await countRows(db().selectFrom('jobs'))).toBe(0)
  const renamed = await core.players.update(actor, player.pid, { name: 'sTEve' })
  expect(renamed).toEqual({ ...player, name: 'sTEve', updatedAt: expect.any(String) as unknown })
  expect(renamed.updatedAt).not.toBe(old)
  expect(await row(player.pid)).toMatchObject({
    uuid: player.uuid,
    name: 'sTEve',
    name_key: 'steve',
    updated_at: renamed.updatedAt,
  })
  await core.jobs.drain()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    actor: { kind: 'user', uid: actor.uid, role: 'user' },
    occurredAt: renamed.updatedAt,
    data: { player: renamed, previousName: 'Steve' },
  })
  expect(await ledger()).toHaveLength(2)
})

test('别人的角色不透露存在性，别人的名字不能占用', async () => {
  const other = await user('other')
  const mine = await create()
  const theirs = await core.players.create(other, { name: 'Alex' })
  await expect(core.players.update(actor, mine.pid, { name: 'Alex' })).rejects.toMatchObject({
    code: 'player_name_taken',
  })
  for (const pid of [theirs.pid, 2147483647]) {
    await expect(core.players.update(actor, pid, { name: 'Other' })).rejects.toMatchObject({ code: 'player_not_found' })
    await expect(core.players.delete(actor, pid)).rejects.toMatchObject({ code: 'player_not_found' })
  }
  expect((await row(theirs.pid)).name).toBe('Alex')
})

test('不同用户并发改成同一个名字，唯一冲突返回领域错误且只提交一个事件', async () => {
  const events = subscribe('player.renamed')
  const other = await user('other')
  const first = await create()
  const second = await core.players.create(other, { name: 'Alex' })
  oneFailure(
    await Promise.allSettled([
      core.players.update(actor, first.pid, { name: 'Shared' }),
      core.players.update(other, second.pid, { name: 'Shared' }),
    ]),
    'player_name_taken',
  )
  expect(await countRows(db().selectFrom('players').where('name_key', '=', 'shared'))).toBe(1)
  expect((await row(first.pid)).uuid).toBe(first.uuid)
  expect((await row(second.pid)).uuid).toBe(second.uuid)
  await core.jobs.drain()
  expect(events).toHaveLength(1)
})

test('删除退还当初实付，忽略现价，流水和事件随删除提交', async () => {
  const events = subscribe('player.deleted')
  const player = await create()
  await setting('score.perPlayer', 999)
  expect(await core.players.delete(actor, player.pid)).toEqual({ refunded: 100 })
  expect(await balance()).toBe(1000)
  const entry = (await ledger()).at(-1)!
  expect(entry).toMatchObject({
    delta: 100,
    balance: 1000,
    reason: 'score.reasons.playerDeleted',
    subject_type: 'player',
    subject_id: player.pid,
  })
  expect(await core.players.listOwned(actor.uid)).toEqual([])
  await core.jobs.drain()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    occurredAt: entry.created_at,
    actor: { kind: 'user', uid: actor.uid, role: 'user' },
    data: { pid: player.pid, uid: actor.uid, name: player.name, uuid: player.uuid },
  })
})

test('关闭退款或实付为零不退，也不写流水', async () => {
  const paid = await create()
  await setting('score.refundOnDelete', false)
  expect(await core.players.delete(actor, paid.pid)).toEqual({ refunded: 0 })
  expect(await ledger()).toHaveLength(2)
  await setting('score.perPlayer', 0)
  await setting('score.refundOnDelete', true)
  const free = await create('Free')
  expect(await core.players.delete(actor, free.pid)).toEqual({ refunded: 0 })
  expect(await balance()).toBe(900)
  expect(await ledger()).toHaveLength(2)
})

test('并发删除只成功一次，只退款一次和发一个事件', async () => {
  const events = subscribe('player.deleted')
  const player = await create()
  oneFailure(
    await Promise.allSettled([core.players.delete(actor, player.pid), core.players.delete(actor, player.pid)]),
    'player_not_found',
  )
  expect(await balance()).toBe(1000)
  expect((await ledger()).filter((x) => x.reason === 'score.reasons.playerDeleted')).toHaveLength(1)
  await core.jobs.drain()
  expect(events).toHaveLength(1)
})

test('签到增加固定积分、记流水和时间，不要求验证邮箱', async () => {
  await setting('checkIn.score', { min: 7, max: 7 })
  await setting('auth.requireEmailVerification', true)
  await db().updateTable('users').set({ email_verified: false }).where('id', '=', actor.uid).execute()
  const before = Date.now()
  const result = await core.users.checkIn(actor)
  expect(result).toEqual({ delta: 7, score: 1007, nextAt: expect.any(String) as unknown })
  const user = await db()
    .selectFrom('users')
    .select('last_check_in_at')
    .where('id', '=', actor.uid)
    .executeTakeFirstOrThrow()
  expect(new Date(user.last_check_in_at!).getTime()).toBeGreaterThanOrEqual(before)
  expect(result.nextAt).toBe(toIsoTimestamp(new Date(new Date(user.last_check_in_at!).getTime() + 24 * 3600000)))
  expect((await ledger()).at(-1)).toMatchObject({
    delta: 7,
    balance: 1007,
    reason: 'score.reasons.checkIn',
    subject_type: null,
    subject_id: null,
    created_at: user.last_check_in_at,
  })
  await expect(core.users.checkIn(actor)).rejects.toMatchObject({
    code: 'check_in_too_early',
    params: { nextAt: result.nextAt },
  })
})

test('签到抽到 0 不写流水，间隔 0 可以立即重签', async () => {
  await setting('checkIn.score', { min: 0, max: 0 })
  await setting('checkIn.gapHours', 0)
  expect(await core.users.checkIn(actor)).toEqual({ delta: 0, score: 1000, nextAt: null })
  expect(await core.users.checkIn(actor)).toEqual({ delta: 0, score: 1000, nextAt: null })
  expect(await ledger()).toHaveLength(1)
})

test('修改上次签到时间构造已满间隔；按零点重置时忽略间隔', async () => {
  await setting('checkIn.score', { min: 1, max: 1 })
  await db().updateTable('users').set({ last_check_in_at: old }).where('id', '=', actor.uid).execute()
  expect((await core.users.checkIn(actor)).delta).toBe(1)
  await setting('checkIn.resetAtMidnight', true)
  await setting('checkIn.gapHours', 999999)
  await setting('site.timeZone', 'America/New_York')
  await db()
    .updateTable('users')
    .set({ last_check_in_at: toIsoTimestamp(new Date(Date.now() - 48 * 3600000)) })
    .where('id', '=', actor.uid)
    .execute()
  const signed = await core.users.checkIn(actor)
  expect(signed.delta).toBe(1)
  await expect(core.users.checkIn(actor)).rejects.toMatchObject({
    code: 'check_in_too_early',
    params: { nextAt: signed.nextAt },
  })
})

test('按零点重置时，恰好在今天零点签的那一次算今天的', async () => {
  await setting('checkIn.score', { min: 1, max: 1 })
  await setting('checkIn.resetAtMidnight', true)
  await setting('site.timeZone', 'UTC')
  const now = new Date()
  const midnight = toIsoTimestamp(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())))
  await db().updateTable('users').set({ last_check_in_at: midnight }).where('id', '=', actor.uid).execute()
  await expect(core.users.checkIn(actor)).rejects.toMatchObject({ code: 'check_in_too_early' })
  expect((await core.users.overview(actor.uid))!.nextCheckInAt).not.toBeNull()
  const before = toIsoTimestamp(new Date(new Date(midnight).getTime() - 1))
  await db().updateTable('users').set({ last_check_in_at: before }).where('id', '=', actor.uid).execute()
  expect((await core.users.checkIn(actor)).delta).toBe(1)
})

test('并发签到只成功一次且只加一次分', async () => {
  await setting('checkIn.score', { min: 5, max: 5 })
  oneFailure(await Promise.allSettled([core.users.checkIn(actor), core.users.checkIn(actor)]), 'check_in_too_early')
  expect(await balance()).toBe(1005)
  expect((await ledger()).filter((x) => x.reason === 'score.reasons.checkIn')).toHaveLength(1)
})

test('封禁和不存在的用户不能签到；失败不更新签到时间', async () => {
  await db().updateTable('users').set({ role: 'banned' }).where('id', '=', actor.uid).execute()
  await expect(core.users.checkIn(actor)).rejects.toMatchObject({ code: 'user_banned' })
  await expect(core.users.checkIn({ uid: 2147483647 })).rejects.toMatchObject({ code: 'unauthenticated' })
  expect((await core.users.overview(actor.uid))!.lastCheckInAt).toBeNull()
  expect(await ledger()).toHaveLength(1)
})

test('overview、recent 和 listOwned 的字段、排序和所有权过滤', async () => {
  const other = await user('other')
  const first = await create()
  const second = await create('Alex')
  await core.players.create(other, { name: 'Other' })
  expect(await core.users.overview(2147483647)).toBeNull()
  expect(await core.users.overview(actor.uid)).toEqual({
    uid: actor.uid,
    nickname: 'owner',
    email: 'owner@example.test',
    emailVerified: true,
    role: 'user',
    score: 800,
    playerCount: 2,
    lastCheckInAt: null,
    nextCheckInAt: null,
  })
  expect(await core.players.listOwned(actor.uid)).toEqual(
    [first, second].map((p) => ({
      pid: p.pid,
      name: p.name,
      uuid: p.uuid,
      skin: null,
      cape: null,
      scorePaid: 100,
      createdAt: p.updatedAt,
      updatedAt: p.updatedAt,
    })),
  )
  const all = await ledger()
  expect(await core.score.recent(actor.uid)).toEqual(
    all
      .reverse()
      .map((x) => ({ id: x.id, delta: x.delta, balance: x.balance, reason: x.reason, createdAt: x.created_at })),
  )
  expect(await core.score.recent(actor.uid, 1)).toHaveLength(1)
  expect(await core.score.recent(actor.uid, 0)).toEqual([])
  await setting('checkIn.score', { min: 1, max: 1 })
  const signed = await core.users.checkIn(actor)
  expect((await core.users.overview(actor.uid))!.nextCheckInAt).toBe(signed.nextAt)
})

test('listOwned 返回皮肤与披风摘要，overview 正确读取未验证布尔值', async () => {
  const player = await create()
  const hash = 'a'.repeat(64)
  await db()
    .insertInto('texture_files')
    .values({
      hash,
      pixel_hash: hash,
      width: 64,
      height: 32,
      size_bytes: 1024,
      ref_count: 2,
      status: 'active',
      claim_id: null,
      status_changed_at: old,
      delete_attempted_at: null,
      delete_confirmed_at: null,
      created_at: old,
    })
    .execute()
  const texture = {
    hash,
    description: '',
    uploader_id: actor.uid,
    is_public: 1 as const,
    created_at: old,
    updated_at: old,
  }
  const skin = await insertReturningId(db(), 'textures', { ...texture, name: '皮肤', type: 'steve' })
  const cape = await insertReturningId(db(), 'textures', { ...texture, name: '披风', type: 'cape' })
  await db()
    .updateTable('players')
    .set({ skin_texture_id: skin, cape_texture_id: cape })
    .where('id', '=', player.pid)
    .execute()
  expect((await core.players.listOwned(actor.uid))[0]).toMatchObject({
    skin: { tid: skin, hash, type: 'steve', scale: 1 },
    cape: { tid: cape, hash, scale: 1 },
  })
  await db().updateTable('users').set({ email_verified: false }).where('id', '=', actor.uid).execute()
  expect((await core.users.overview(actor.uid))!.emailVerified).toBe(false)
})

test('recent 默认最多十条，并按流水 id 倒序，只返回当前用户', async () => {
  await setting('checkIn.gapHours', 0)
  await setting('checkIn.score', { min: 1, max: 1 })
  for (let i = 0; i < 11; i++) await core.users.checkIn(actor)
  await user('other')
  const recent = await core.score.recent(actor.uid)
  expect(recent).toHaveLength(10)
  expect(recent.map((x) => x.id)).toEqual([...recent.map((x) => x.id)].sort((a, b) => b - a))
  expect(recent[0]).toMatchObject({ delta: 1, balance: 1011, reason: 'score.reasons.checkIn' })
  expect(await core.score.recent(2147483647)).toEqual([])
})
