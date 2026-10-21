import { createHash } from 'node:crypto'
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
import { hashPassword } from 'better-auth/crypto'
import type { EventName } from '@nextskin/plugin-sdk'
import type { KyselyPlugin, QueryId, Transaction } from 'kysely'
import { afterAll, beforeAll, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import {
  createCore,
  encodeSettingValue,
  type Core,
  type CoreSettingKey,
  type CoreSettingValue,
  type TextureStorage,
} from '../index.ts'
import { adjustScore } from '../score/adjust.ts'
import { createTextureFiles, TEXTURE_RECYCLE_JOB } from './files.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const old = toIsoTimestamp(new Date('2020-01-01T00:00:00.000Z'))
let clock: number, database: TestDatabase<CoreDatabase>, core: Core, owner: { uid: number }, passwordHash: string
let storage: ReturnType<typeof createStorage>, objects: Map<string, Uint8Array>
let warm: MockInstance<Core['renders']['warm']>, purge: MockInstance<Core['renders']['purge']>
const db = () => database.db
const now = () => new Date(clock)
const hash = (seed = 1) => createHash('sha256').update(Uint8Array.of(seed)).digest('hex')
const processImage = vi.fn(({ bytes, type }: { bytes: Uint8Array; type: string }) =>
  Promise.resolve({
    png: new Uint8Array(1500).fill(bytes[0]!),
    pixelHash: hash(bytes[0]),
    width: 64,
    height: type === 'cape' || bytes[0] === 20 ? 32 : 64,
  }),
)
const pool = {
  processUpload: processImage,
  inspect: vi.fn(),
  render: () => Promise.resolve(new Uint8Array()),
  processSiteImage: vi.fn(),
  close: () => Promise.resolve(),
}
function createStorage(lateWindow: number) {
  return {
    list: () => Promise.resolve([]),
    listTemp: () => Promise.resolve([]),
    lateDeleteWindowMs: lateWindow,
    read: vi.fn<TextureStorage['read']>((key) => Promise.resolve(objects.get(key) ?? null)),
    write: vi.fn<TextureStorage['write']>((key, _claim, bytes) => {
      objects.set(key, bytes)
      return Promise.resolve()
    }),
    delete: vi.fn<TextureStorage['delete']>((key) => {
      objects.delete(key)
      return Promise.resolve()
    }),
    deleteTemp: vi.fn<TextureStorage['deleteTemp']>(() => Promise.resolve()),
  }
}
function makeCore(lateWindow = 0, connection = db()) {
  storage = createStorage(lateWindow)
  core = createCore({
    db: connection,
    secretKey,
    production: false,
    textureStorage: storage,
    imagePool: pool,
    now,
    textureClaimLeaseMs: 10,
    textureDeleteDelayMs: 20,
    textureDeleteAttemptLeaseMs: 100,
    jobs: { log: () => {} },
  })
  warm = vi.spyOn(core.renders, 'warm').mockImplementation(() => {})
  purge = vi.spyOn(core.renders, 'purge').mockResolvedValue()
}
beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(db(), coreMigrations)
  passwordHash = await hashPassword('password123')
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  await db().deleteFrom('players').execute()
  await db().deleteFrom('closet_items').execute()
  await db().deleteFrom('textures').execute()
  await db().deleteFrom('texture_files').execute()
  await db().deleteFrom('users').execute()
  await db().deleteFrom('jobs').execute()
  await db().deleteFrom('settings').execute()
  objects = new Map()
  clock = Date.parse('2026-10-18T00:00:00Z')
  processImage.mockClear()
  makeCore()
  owner = await user('owner')
})
async function user(name: string, score = 1000) {
  const uid = await insertReturningId(db(), 'users', {
    nickname: name,
    email: `${name}@test.example`,
    email_verified: true,
    created_at: writeAuthDate(db(), old),
    updated_at: writeAuthDate(db(), old),
  })
  if (score)
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
const upload = (actor = owner, seed = 1, visible = true, extra = {}) =>
  core.textures.upload(actor, { bytes: Uint8Array.of(seed), name: 'Test', type: 'steve', public: visible, ...extra })
const file = (key = hash()) => db().selectFrom('texture_files').selectAll().where('hash', '=', key).executeTakeFirst()
const textureRow = (tid: number) =>
  db().selectFrom('textures').selectAll().where('id', '=', tid).executeTakeFirstOrThrow()
const balance = async (uid = owner.uid) =>
  (await db().selectFrom('users').select('score').where('id', '=', uid).executeTakeFirstOrThrow()).score
async function ledgerCheck() {
  for (const user of await db().selectFrom('users').select(['id', 'score']).execute()) {
    const entries = await db().selectFrom('score_transactions').select('delta').where('user_id', '=', user.id).execute()
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(user.score)
  }
}
function subscribe(...names: EventName[]) {
  for (const name of names) core.events.subscribe(name, `test:${name}`, { run: () => Promise.resolve() })
}
async function events(name: string) {
  return (await db().selectFrom('jobs').select('payload').where('name', '=', `test:${name}`).execute()).map(
    (row) => JSON.parse(row.payload) as { actor: { uid: number }; data: Record<string, unknown> },
  )
}
async function addDependencies(tid: number, actor: { uid: number }, paid = 7) {
  await transactionWithRetry(db(), async (tx) => {
    await tx
      .insertInto('closet_items')
      .values({ user_id: actor.uid, texture_id: tid, name: 'custom', score_paid: paid, created_at: old })
      .execute()
    await tx
      .updateTable('textures')
      .set((eb) => ({ likes: eb('likes', '+', 1) }))
      .where('id', '=', tid)
      .execute()
    if (paid) await adjustScore(tx, { uid: actor.uid, delta: -paid, reason: 'test', now: old })
  })
  const player = await core.players.create(actor, { name: `User${actor.uid}` })
  await db()
    .updateTable('players')
    .set({ skin_texture_id: tid, updated_at: old })
    .where('id', '=', player.pid)
    .execute()
  await db().updateTable('users').set({ avatar_texture_id: tid }).where('id', '=', actor.uid).execute()
  return player.pid
}

test('上传新文件、存储费与衣柜费实付、DTO、事务事件与流水', async () => {
  await setting('score.perClosetItem', 7)
  subscribe('texture.uploaded', 'closet.itemAdded')
  const result = await upload(owner, 1, true, { name: ' 名字 ', description: ' 描述\n内容 ' })
  expect((await core.textures.detail(owner.uid, result.texture.tid))?.management).toEqual({
    visibilityDelta: 18,
    deleteRefund: 9,
    othersInCloset: 0,
  })
  expect(result.charged).toBe(9)
  expect(result.texture).toMatchObject({
    name: '名字',
    description: '描述\n内容',
    width: 64,
    height: 64,
    sizeBytes: 1500,
    likes: 1,
    uploader: owner.uid,
  })
  expect(await balance()).toBe(991)
  expect(await textureRow(result.texture.tid)).toMatchObject({ score_paid: 2 })
  expect(await file()).toMatchObject({ status: 'active', ref_count: 1, pixel_hash: hash() })
  expect(storage.write).toHaveBeenCalledOnce()
  expect(warm).toHaveBeenCalledWith(hash(), 'steve')
  expect(await events('texture.uploaded')).toHaveLength(1)
  expect(await events('closet.itemAdded')).toHaveLength(1)
  await ledgerCheck()
})
test('复用导入的旧 hash；有多个像素相同的旧文件时取 hash 最小的并按旧文件大小收费', async () => {
  for (const key of ['b'.repeat(64), 'a'.repeat(64)])
    await db()
      .insertInto('texture_files')
      .values({
        hash: key,
        pixel_hash: hash(),
        width: 64,
        height: 64,
        size_bytes: 3100,
        ref_count: 0,
        status: 'active',
        claim_id: null,
        status_changed_at: old,
        delete_attempted_at: null,
        delete_confirmed_at: null,
        created_at: old,
      })
      .execute()
  const result = await upload()
  expect(result.texture.hash).toBe('a'.repeat(64))
  expect(result.charged).toBe(4)
  expect(result.texture.sizeBytes).toBe(3100)
  expect(storage.write).not.toHaveBeenCalled()
  expect((await file('a'.repeat(64)))?.ref_count).toBe(1)
  await ledgerCheck()
})
test('自己的私有与别人的公开拒绝；别人的私有可复用，不泄露 tid；最小 tid 查重', async () => {
  const other = await user('other'),
    first = await upload(owner, 1, false)
  await expect(upload(owner)).rejects.toMatchObject({ code: 'texture_duplicate', params: { tid: first.texture.tid } })
  const second = await upload(other, 1, true)
  await expect(upload(await user('third'))).rejects.toMatchObject({
    code: 'texture_duplicate',
    params: { tid: second.texture.tid },
  })
  expect((await file())?.ref_count).toBe(2)
  expect(storage.write).toHaveBeenCalledOnce()
  await ledgerCheck()
})
test('余额不足回滚材质、衣柜、事件与激活，留下 pending 给租期任务', async () => {
  subscribe('texture.uploaded', 'closet.itemAdded')
  await setting('score.perKbPublic', 1000)
  await expect(upload()).rejects.toMatchObject({ code: 'score_insufficient' })
  expect(await countRows(db().selectFrom('textures'))).toBe(0)
  expect(await countRows(db().selectFrom('closet_items'))).toBe(0)
  expect(await events('texture.uploaded')).toEqual([])
  expect(await balance()).toBe(1000)
  expect(await file()).toMatchObject({ status: 'pending', ref_count: 0 })
  expect(storage.delete).not.toHaveBeenCalled()
  await ledgerCheck()
})
test('两个人同时公开上传同一图只有一人成功；同一用户并发上传不会透支', async () => {
  const other = await user('other')
  const results = await Promise.allSettled([upload(), upload(other)])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'texture_duplicate' } }])
  expect((await file())?.ref_count).toBe(1)
  const poor = await user('poor', 2)
  const more = await Promise.allSettled([upload(poor, 2), upload(poor, 3)])
  expect(more.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(more.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'score_insufficient' } }])
  expect(await balance(poor.uid)).toBe(0)
  await ledgerCheck()
})
test('名字与描述按码位处理、正则规则错误、空描述；校验先于解码', async () => {
  for (const [extra, code] of [
    [{ name: ' ' }, 'texture_name_length'],
    [{ name: '😀'.repeat(129) }, 'texture_name_length'],
    [{ description: '😀'.repeat(2001) }, 'texture_description_too_long'],
  ] as const)
    await expect(upload(owner, 1, true, extra)).rejects.toMatchObject({ code })
  await setting('texture.nameRegex', '[')
  await expect(upload()).rejects.toMatchObject({ code: 'texture_name_rule_misconfigured' })
  await setting('texture.nameRegex', '^A')
  await expect(upload()).rejects.toMatchObject({ code: 'texture_name_invalid' })
  expect(processImage).not.toHaveBeenCalled()
  await setting('texture.nameRegex', '')
  expect((await upload(owner, 1, true, { name: '😀'.repeat(128), description: ' \n ' })).texture.description).toBeNull()
})
test('封禁、邮箱验证、不存在用户先于解码；事务里再次检查用户状态', async () => {
  await db().updateTable('users').set({ role: 'banned' }).where('id', '=', owner.uid).execute()
  await expect(upload()).rejects.toMatchObject({ code: 'user_banned' })
  await db().updateTable('users').set({ role: 'user', email_verified: false }).where('id', '=', owner.uid).execute()
  await setting('auth.requireEmailVerification', true)
  await expect(upload()).rejects.toMatchObject({ code: 'email_not_verified' })
  await expect(upload({ uid: 2147483647 })).rejects.toMatchObject({ code: 'unauthenticated' })
  expect(processImage).not.toHaveBeenCalled()
  await db().updateTable('users').set({ email_verified: true }).where('id', '=', owner.uid).execute()
  storage.write.mockImplementationOnce(async () => {
    await db().updateTable('users').set({ role: 'banned' }).where('id', '=', owner.uid).execute()
  })
  await expect(upload()).rejects.toMatchObject({ code: 'user_banned' })
  expect((await file())?.status).toBe('pending')
})
test('改名描述模型只发真正变化的字段；模型修改更新所有角色的时间；拒绝非法转换', async () => {
  subscribe('texture.updated')
  const { texture } = await upload(),
    other = await user('other')
  const pid = await addDependencies(texture.tid, other)
  clock += 100
  const result = await core.textures.update(owner, texture.tid, { name: ' Renamed ', description: ' D ', type: 'alex' })
  expect(result.texture).toMatchObject({ name: 'Renamed', description: 'D', type: 'alex' })
  expect(result.scoreDelta).toBe(0)
  expect(await db().selectFrom('players').select('updated_at').where('id', '=', pid).executeTakeFirstOrThrow()).toEqual(
    { updated_at: toIsoTimestamp(now()) },
  )
  expect((await core.players.listOwned(other.uid))[0]?.skin).toMatchObject({ type: 'alex', scale: 1 })
  expect((await events('texture.updated'))[0]?.data.fields).toEqual(['name', 'type', 'description'])
  await core.textures.update(owner, texture.tid, { name: 'Renamed', description: 'D', type: 'alex', public: true })
  expect(await events('texture.updated')).toHaveLength(1)
  await expect(core.textures.update(owner, texture.tid, { type: 'cape' })).rejects.toMatchObject({
    code: 'texture_type_invalid',
  })
  const legacy = await upload(owner, 20)
  await expect(core.textures.update(owner, legacy.texture.tid, { type: 'alex' })).rejects.toMatchObject({
    code: 'texture_type_invalid',
  })
  const cape = await upload(owner, 3, true, { type: 'cape' })
  await expect(core.textures.update(owner, cape.texture.tid, { type: 'steve' })).rejects.toMatchObject({
    code: 'texture_type_invalid',
  })
  await core.textures.update(owner, texture.tid, { description: null })
  expect((await textureRow(texture.tid)).description).toBeNull()
})
test.each([true, false])('改私有清理其他用户，实付退款开关 %s，自己的依赖不变', async (refund) => {
  await setting('score.refundOnDelete', refund)
  await setting('score.perClosetItem', 3)
  const { texture } = await upload(),
    other = await user('other'),
    third = await user('third')
  const ownPlayer = await core.players.create(owner, { name: 'Mine' })
  await db().updateTable('players').set({ skin_texture_id: texture.tid }).where('id', '=', ownPlayer.pid).execute()
  await db().updateTable('users').set({ avatar_texture_id: texture.tid }).where('id', '=', owner.uid).execute()
  const pid = await addDependencies(texture.tid, other, 7)
  await addDependencies(texture.tid, third, 11)
  const before = await balance(other.uid)
  subscribe('closet.itemRemoved', 'player.texturesChanged', 'user.profileUpdated', 'texture.updated')
  clock += 100
  const result = await core.textures.update(owner, texture.tid, { public: false })
  expect(result.scoreDelta).toBe(-18)
  expect(result.texture.likes).toBe(1)
  expect((await textureRow(texture.tid)).score_paid).toBe(20)
  expect(await balance(other.uid)).toBe(before + (refund ? 7 : 0))
  expect(
    await db().selectFrom('closet_items').select('user_id').where('texture_id', '=', texture.tid).execute(),
  ).toEqual([{ user_id: owner.uid }])
  expect(
    await db()
      .selectFrom('players')
      .select(['skin_texture_id', 'updated_at'])
      .where('id', '=', pid)
      .executeTakeFirstOrThrow(),
  ).toEqual({ skin_texture_id: null, updated_at: toIsoTimestamp(now()) })
  expect(
    (
      await db()
        .selectFrom('players')
        .select('skin_texture_id')
        .where('id', '=', ownPlayer.pid)
        .executeTakeFirstOrThrow()
    ).skin_texture_id,
  ).toBe(texture.tid)
  expect(
    (await db().selectFrom('users').select('avatar_texture_id').where('id', '=', other.uid).executeTakeFirstOrThrow())
      .avatar_texture_id,
  ).toBeNull()
  expect(
    (await db().selectFrom('users').select('avatar_texture_id').where('id', '=', owner.uid).executeTakeFirstOrThrow())
      .avatar_texture_id,
  ).toBe(texture.tid)
  expect(await events('closet.itemRemoved')).toHaveLength(2)
  expect(await events('player.texturesChanged')).toHaveLength(2)
  expect(await events('user.profileUpdated')).toHaveLength(2)
  expect((await events('player.texturesChanged'))[0]).toMatchObject({
    actor: { uid: owner.uid },
    data: { previous: { skin: texture.tid, cape: null } },
  })
  await setting('score.perKbPublic', 3)
  expect((await core.textures.update(owner, texture.tid, { public: true })).scoreDelta).toBe(14)
  expect((await textureRow(texture.tid)).score_paid).toBe(6)
  await ledgerCheck()
})
test('改私有余额不足全部回滚，改公开撞上别人的公开条目', async () => {
  const { texture } = await upload(),
    other = await user('other')
  await addDependencies(texture.tid, other)
  await setting('score.perKbPrivate', 1000)
  await expect(core.textures.update(owner, texture.tid, { public: false })).rejects.toMatchObject({
    code: 'score_insufficient',
  })
  expect(await textureRow(texture.tid)).toMatchObject({ is_public: 1, likes: 2, score_paid: 2 })
  await setting('score.perKbPrivate', 10)
  const privateCopy = await upload(other, 2, false),
    publicCopy = await upload(owner, 2, true)
  await expect(core.textures.update(other, privateCopy.texture.tid, { public: true })).rejects.toMatchObject({
    code: 'texture_duplicate',
    params: { tid: publicCopy.texture.tid },
  })
  await ledgerCheck()
})
test('修改和删除：别人公开为 not_owned，别人私有与不存在为 not_found，注销后的公开也不能改', async () => {
  const other = await user('other'),
    pub = await upload(),
    priv = await upload(owner, 2, false)
  for (const tid of [pub.texture.tid, priv.texture.tid, 2147483647]) {
    const code = tid === pub.texture.tid ? 'texture_not_owned' : 'texture_not_found'
    await expect(core.textures.update(other, tid, {})).rejects.toMatchObject({ code })
    await expect(core.textures.delete(other, tid)).rejects.toMatchObject({ code })
  }
  await db().updateTable('textures').set({ uploader_id: null }).where('id', '=', pub.texture.tid).execute()
  await expect(core.textures.update(owner, pub.texture.tid, {})).rejects.toMatchObject({ code: 'texture_not_owned' })
})
test.each([true, false])('删除按实付退存储和衣柜费 %s，清所有依赖，ref_count 为零标记回收', async (refund) => {
  await setting('score.refundOnDelete', refund)
  await setting('score.perClosetItem', 3)
  const { texture } = await upload(),
    other = await user('other')
  const pid = await addDependencies(texture.tid, other)
  await setting('score.perKbPublic', 100)
  await setting('score.perClosetItem', 100)
  subscribe('texture.deleted', 'closet.itemRemoved', 'player.texturesChanged', 'user.profileUpdated')
  const before = await balance(other.uid)
  const result = await core.textures.delete(owner, texture.tid)
  expect(result.refunded).toBe(refund ? 5 : 0)
  expect(await balance(other.uid)).toBe(before + (refund ? 7 : 0))
  expect(await file()).toMatchObject({ status: 'deleting', ref_count: 0, delete_attempted_at: null })
  expect(await countRows(db().selectFrom('jobs').where('name', '=', TEXTURE_RECYCLE_JOB))).toBe(1)
  expect((await events('texture.deleted'))[0]?.data.lastReference).toBe(true)
  expect(await events('closet.itemRemoved')).toHaveLength(2)
  expect(
    (await db().selectFrom('players').select('skin_texture_id').where('id', '=', pid).executeTakeFirstOrThrow())
      .skin_texture_id,
  ).toBeNull()
  expect(await core.textures.findFile(hash())).toBeNull()
  await ledgerCheck()
})
test('删除共享文件的一个条目只减引用，不开始回收', async () => {
  const first = await upload(owner, 1, false),
    other = await upload(await user('other'), 1, false)
  expect((await file())?.ref_count).toBe(2)
  subscribe('texture.deleted')
  await core.textures.delete(owner, first.texture.tid)
  expect(await file()).toMatchObject({ status: 'active', ref_count: 1 })
  expect((await events('texture.deleted'))[0]?.data.lastReference).toBe(false)
  expect(await textureRow(other.texture.tid)).toBeDefined()
})
test('放弃认领 → 租期到期 → deleting → D 后删存储缓存和行；active 不被租期检查回收', async () => {
  await setting('score.perKbPublic', 1000)
  await expect(upload()).rejects.toMatchObject({ code: 'score_insufficient' })
  expect(objects.has(hash())).toBe(true)
  clock += 10
  await core.jobs.drain()
  expect(await file()).toMatchObject({ status: 'deleting' })
  expect(storage.deleteTemp).toHaveBeenCalledOnce()
  clock += 21
  await core.jobs.drain()
  expect(storage.delete).toHaveBeenCalledWith(hash())
  expect(purge).toHaveBeenCalledWith(hash())
  expect(await file()).toBeUndefined()
  await setting('score.perKbPublic', 1)
  await upload(owner, 2)
  clock += 100
  await core.jobs.drain()
  expect(await file(hash(2))).toMatchObject({ status: 'active', ref_count: 1 })
})
test('D 内复活，旧回收任务不删除文件；再次删除仍安排完整 D', async () => {
  const first = await upload()
  await core.textures.delete(owner, first.texture.tid)
  clock += 5
  const revived = await upload()
  expect((await file())?.status).toBe('active')
  clock += 16
  await core.jobs.drain()
  expect(storage.delete).not.toHaveBeenCalled()
  await core.textures.delete(owner, revived.texture.tid)
  clock += 21
  await core.jobs.drain()
  expect(storage.delete).toHaveBeenCalledOnce()
  expect(await file()).toBeUndefined()
})
test('旧任务早到不影响第二轮 D 的新任务', async () => {
  const first = await upload()
  await core.textures.delete(owner, first.texture.tid)
  clock += 5
  const second = await upload()
  await core.textures.delete(owner, second.texture.tid)
  clock += 16
  await core.jobs.drain()
  expect(storage.delete).not.toHaveBeenCalled()
  clock += 5
  await core.jobs.drain()
  expect(storage.delete).toHaveBeenCalledOnce()
  expect(await file()).toBeUndefined()
})
test('远程存储 L 期间保留删除行，不能重新认领；L 后第三个任务删行', async () => {
  makeCore(100)
  const { texture } = await upload()
  await core.textures.delete(owner, texture.tid)
  clock += 21
  await core.jobs.drain()
  expect(await file()).toMatchObject({ status: 'deleting', delete_confirmed_at: toIsoTimestamp(now()) })
  expect(storage.delete).toHaveBeenCalledOnce()
  clock += 100
  await core.jobs.drain()
  expect(await file()).toBeDefined()
  clock += 1
  await core.jobs.drain()
  expect(await file()).toBeUndefined()
})
test('list 筛选、字面搜索、排序、分页、上传者私有可见性、inCloset；detail 的管理数据', async () => {
  const other = await user('other'),
    first = await upload(owner, 1, true, { name: 'A%_!\\中' })
  const second = await upload(owner, 2, true, { type: 'alex', name: 'Another' })
  const priv = await upload(owner, 3, false)
  await upload(other, 4, true, { type: 'cape' })
  await addDependencies(first.texture.tid, other)
  const list = (extra = {}) =>
    core.textures.list({ viewer: other.uid, type: 'skin', sort: 'latest', page: 1, ...extra })
  expect((await list()).items.map((t) => t.tid)).toEqual([second.texture.tid, first.texture.tid])
  expect((await list({ sort: 'popular', perPage: 1 })).items[0]).toMatchObject({
    tid: first.texture.tid,
    inCloset: true,
    uploaderName: 'owner',
    scale: 1,
  })
  expect((await list({ sort: 'popular', perPage: 1, page: 2 })).items[0]?.tid).toBe(second.texture.tid)
  for (const q of ['%', '_', '!', '\\', '中', 'a%'])
    expect((await list({ q: ` ${q} ` })).items.map((t) => t.tid)).toEqual([first.texture.tid])
  expect((await list({ q: '   ' })).total).toBe(2)
  expect((await list({ type: 'alex' })).total).toBe(1)
  expect((await list({ type: 'cape' })).total).toBe(1)
  expect((await list({ uploader: owner.uid })).total).toBe(2)
  expect((await list({ viewer: owner.uid, uploader: owner.uid })).total).toBe(3)
  expect((await list({ viewer: null, uploader: owner.uid })).total).toBe(2)
  expect((await list({ viewer: null })).items.every((item) => !item.inCloset)).toBe(true)
  expect(await core.textures.detail(other.uid, priv.texture.tid)).toBeNull()
  expect(await core.textures.detail(null, priv.texture.tid)).toBeNull()
  const detail = await core.textures.detail(owner.uid, first.texture.tid)
  expect(detail).toMatchObject({
    uploader: { uid: owner.uid, nickname: 'owner', avatar: null },
    management: { visibilityDelta: 18, deleteRefund: 2, othersInCloset: 1 },
  })
  expect(await core.textures.detail(other.uid, first.texture.tid)).not.toHaveProperty('management')
  await setting('score.refundOnDelete', false)
  expect((await core.textures.detail(owner.uid, priv.texture.tid))?.management?.deleteRefund).toBe(0)
})
test('删除账号先清衣柜扣收藏数，删除私有材质，公开保留并置空上传者；不退自己的积分', async () => {
  const other = await user('other'),
    mine = await upload(),
    priv = await upload(owner, 2, false),
    theirs = await upload(other, 3)
  await addDependencies(theirs.texture.tid, owner)
  await addDependencies(priv.texture.tid, other, 9)
  const otherBalance = await balance(other.uid)
  await db()
    .insertInto('accounts')
    .values({
      user_id: owner.uid,
      provider_id: 'credential',
      account_id: String(owner.uid),
      password: passwordHash,
      access_token: null,
      refresh_token: null,
      id_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      scope: null,
      created_at: writeAuthDate(db(), old),
      updated_at: writeAuthDate(db(), old),
    })
    .execute()
  subscribe('closet.itemRemoved', 'texture.deleted')
  await core.users.deleteAccount(owner, { password: 'password123' })
  expect(await countRows(db().selectFrom('closet_items').where('user_id', '=', owner.uid))).toBe(0)
  expect(await countRows(db().selectFrom('textures').where('id', '=', priv.texture.tid))).toBe(0)
  expect(await textureRow(mine.texture.tid)).toMatchObject({ uploader_id: null, likes: 0 })
  expect((await textureRow(theirs.texture.tid)).likes).toBe(1)
  expect(await file(hash(2))).toMatchObject({ ref_count: 0, status: 'deleting' })
  expect(await events('closet.itemRemoved')).toHaveLength(4)
  expect(await balance(other.uid)).toBe(otherBalance + 9)
  expect(await events('texture.deleted')).toHaveLength(1)
  expect((await core.textures.detail(null, mine.texture.tid))?.uploader).toBeNull()
  await ledgerCheck()
})

test('激活前认领被接手时从找文件重来；不删除已写入对象', async () => {
  storage.write.mockImplementationOnce(async (key, _claim, bytes) => {
    objects.set(key, bytes)
    await db()
      .updateTable('texture_files')
      .set({ status: 'deleting', claim_id: '00000000-0000-4000-8000-000000000001', status_changed_at: old })
      .where('hash', '=', key)
      .execute()
  })
  expect((await upload()).texture.hash).toBe(hash())
  expect(storage.write).toHaveBeenCalledTimes(2)
  expect(storage.delete).not.toHaveBeenCalled()
  expect(await file()).toMatchObject({ status: 'active', ref_count: 1 })
})
test('别人 pending 和已经开始 deleting 的行短暂等待后返回 503，不覆写存储', async () => {
  await setting('score.perKbPublic', 1000)
  await expect(upload()).rejects.toMatchObject({ code: 'score_insufficient' })
  const other = await user('other')
  const before = storage.write.mock.calls.length
  await expect(upload(other)).rejects.toMatchObject({ code: 'service_unavailable' })
  await db()
    .updateTable('texture_files')
    .set({ status: 'deleting', delete_attempted_at: old })
    .where('hash', '=', hash())
    .execute()
  await expect(upload(other)).rejects.toMatchObject({ code: 'service_unavailable' })
  expect(storage.write).toHaveBeenCalledTimes(before)
})
test('L 一半已过就放弃本次删除请求，随后由任务重试', async () => {
  makeCore(100)
  const { texture } = await upload()
  await core.textures.delete(owner, texture.tid)
  clock += 21
  let paused = false
  Object.defineProperty(storage, 'lateDeleteWindowMs', {
    get: () => {
      if (!paused) {
        paused = true
        clock += 60
      }
      return 100
    },
  })
  await core.jobs.drain()
  expect(storage.delete).not.toHaveBeenCalled()
  expect(await file()).toMatchObject({ status: 'deleting', delete_confirmed_at: null })
  clock += 20_000
  await core.jobs.drain()
  expect(storage.delete).toHaveBeenCalledOnce()
  clock += 101
  await core.jobs.drain()
  expect(await file()).toBeUndefined()
})
test('价格超出数据库整数可存范围仍返回余额不足并回滚，所有方言一致', async () => {
  await setting('score.perKbPublic', 2147483647)
  await expect(upload()).rejects.toMatchObject({
    code: 'score_insufficient',
    params: { required: 4294967294, balance: 1000 },
  })
  expect(await countRows(db().selectFrom('textures'))).toBe(0)
  await ledgerCheck()
})

test('导入的不同旧 hash 像素相同，两人同时改公开仍只有一个成功', async () => {
  const first = await upload(owner, 1, false)
  const other = await user('other'),
    oldHash = '0'.repeat(64)
  const original = (await file())!
  await db()
    .insertInto('texture_files')
    .values({ ...original, hash: oldHash, ref_count: 1 })
    .execute()
  const tid = await insertReturningId(db(), 'textures', {
    hash: oldHash,
    name: 'Imported',
    type: 'steve',
    description: null,
    uploader_id: other.uid,
    is_public: 0,
    likes: 0,
    score_paid: 0,
    created_at: old,
    updated_at: old,
  })
  const results = await Promise.allSettled([
    core.textures.update(owner, first.texture.tid, { public: true }),
    core.textures.update(other, tid, { public: true }),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toMatchObject([{ reason: { code: 'texture_duplicate' } }])
  expect(await countRows(db().selectFrom('textures').where('is_public', '=', 1))).toBe(1)
  await ledgerCheck()
})

/** 保留真实提交，只暂停提交结果返回：模拟进程在提交之后、调用 storage.delete 之前被挂起。 */
function pauseNextCommit() {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const transaction = db().transaction.bind(db())
  let armed = true
  const spy = vi.spyOn(db(), 'transaction').mockImplementation(() => {
    const builder = transaction()
    const execute = builder.execute.bind(builder)
    builder.execute = async <T>(run: (tx: Transaction<CoreDatabase>) => Promise<T>): Promise<T> => {
      const result = await execute(run)
      if (armed) {
        armed = false
        entered.resolve()
        await release.promise
      }
      return result
    }
    return builder
  })
  return { entered: entered.promise, resume: () => release.resolve(), restore: () => spy.mockRestore() }
}
function recycler() {
  const files = createTextureFiles({
    db: db(),
    storage,
    renders: core.renders,
    jobs: core.jobs,
    now,
    leaseMs: 10,
    deleteDelayMs: 20,
    attemptLeaseMs: 100,
  })
  return () =>
    files.handlers[TEXTURE_RECYCLE_JOB]!.run({
      jobId: 0,
      payload: { hash: hash() },
      attempt: 1,
      signal: new AbortController().signal,
    })
}

test.each([0, 80])(
  '并发回收：旧尝试提交后暂停，后续任务回收并重新上传后，旧尝试不能删新对象（L=%s）',
  async (lateWindow) => {
    makeCore(lateWindow)
    const firstUpload = await upload()
    await core.textures.delete(owner, firstUpload.texture.tid)
    clock += 5
    const revived = await upload()
    await core.textures.delete(owner, revived.texture.tid)
    clock += 21
    const run = recycler(),
      pause = pauseNextCommit()
    const first = run().then(
      () => null,
      (error: unknown) => error,
    )
    try {
      await pause.entered
      const attemptedAt = (await file())!.delete_attempted_at!
      await run()
      expect(storage.delete).not.toHaveBeenCalled()
      expect((await file())!.delete_attempted_at).toBe(attemptedAt)
      // 超过尝试租期，另一个执行者才可以接手；旧执行者仍停在 delete 之前。
      clock += 101
      await run()
      if (lateWindow > 0) {
        clock += lateWindow + 1
        await core.jobs.drain()
      }
      expect(await file()).toBeUndefined()
      const fresh = await upload()
      expect(fresh.texture.hash).toBe(hash())
      pause.resume()
      expect(await first).toMatchObject({ code: 'service_unavailable' })
      expect(storage.delete).toHaveBeenCalledOnce()
      expect(await file()).toMatchObject({ status: 'active', ref_count: 1 })
      expect(objects.has(hash())).toBe(true)
      await core.jobs.drain()
      expect(await file()).toMatchObject({ status: 'active', ref_count: 1 })
      expect(objects.has(hash())).toBe(true)
    } finally {
      pause.resume()
      await first
      pause.restore()
    }
  },
)

test.each([0, 80])('尝试租期内不接手，排无去重键的接续任务；原执行者放弃后自动完成回收（L=%s）', async (lateWindow) => {
  makeCore(lateWindow)
  const { texture } = await upload()
  await core.textures.delete(owner, texture.tid)
  clock += 21
  // 只保留本次争用排出的任务，证明恢复不依赖其他旧回收任务。
  await db().deleteFrom('jobs').where('name', '=', TEXTURE_RECYCLE_JOB).execute()
  const run = recycler(),
    pause = pauseNextCommit(),
    started = clock
  const first = run().then(
    () => null,
    (error: unknown) => error,
  )
  try {
    await pause.entered
    await run()
    const followups = await db()
      .selectFrom('jobs')
      .select(['dedupe_key', 'run_at'])
      .where('name', '=', TEXTURE_RECYCLE_JOB)
      .execute()
    expect(followups).toEqual([{ dedupe_key: null, run_at: toIsoTimestamp(new Date(started + 101)) }])
    expect(storage.delete).not.toHaveBeenCalled()
    clock += 50
    pause.resume()
    expect(await first).toMatchObject({ code: 'service_unavailable' })
    clock = started + 100
    await core.jobs.drain()
    expect(storage.delete).not.toHaveBeenCalled()
    clock++
    await core.jobs.drain()
    expect(storage.delete).toHaveBeenCalledOnce()
    if (lateWindow > 0) {
      clock += lateWindow + 1
      await core.jobs.drain()
    }
    expect(await file()).toBeUndefined()
  } finally {
    pause.resume()
    await first
    pause.restore()
  }
})

test.each([0, 40, 400])('提交后暂停超过 min(尝试租期, L) 的一半，放弃删除（L=%s）', async (lateWindow) => {
  makeCore(lateWindow)
  const { texture } = await upload()
  await core.textures.delete(owner, texture.tid)
  clock += 21
  const run = recycler(),
    pause = pauseNextCommit()
  const first = run().then(
    () => null,
    (error: unknown) => error,
  )
  try {
    await pause.entered
    const attemptedAt = (await file())!.delete_attempted_at
    clock += (lateWindow > 0 ? Math.min(100, lateWindow) : 100) / 2
    pause.resume()
    expect(await first).toMatchObject({ code: 'service_unavailable' })
    expect(storage.delete).not.toHaveBeenCalled()
    expect(await file()).toMatchObject({
      status: 'deleting',
      delete_attempted_at: attemptedAt,
      delete_confirmed_at: null,
    })
    expect(objects.has(hash())).toBe(true)
  } finally {
    pause.resume()
    await first
    pause.restore()
  }
})

/** SQLite 不能在写事务之间插入另一个写者；在四库统一回放 affected 预读里已失效的 uid。 */
function staleAffectedUser(uid: number, onReplay: () => void): KyselyPlugin {
  const queries = new Set<QueryId>()
  return {
    transformQuery({ node, queryId }) {
      const query = JSON.stringify(node)
      if (
        node.kind === 'SelectQueryNode' &&
        query.includes('"closet_items"') &&
        query.includes('"avatar_texture_id"') &&
        query.includes('"players"')
      )
        queries.add(queryId)
      return node
    },
    transformResult({ result, queryId }) {
      if (!queries.delete(queryId)) return Promise.resolve(result)
      onReplay()
      return Promise.resolve({
        ...result,
        rows: [...result.rows, { id: uid }].sort((a, b) => Number(a.id) - Number(b.id)),
      })
    },
  }
}
test.each(['private', 'delete'])('清理的预读用户已经注销时跳过，继续给后续用户退款并提交（%s）', async (operation) => {
  const { texture } = await upload(),
    gone = await user('gone'),
    alive = await user('alive')
  await db().updateTable('users').set({ avatar_texture_id: texture.tid }).where('id', '=', gone.uid).execute()
  await db().deleteFrom('users').where('id', '=', gone.uid).execute()
  const pid = await addDependencies(texture.tid, alive, 7),
    before = await balance(alive.uid)
  let replays = 0
  makeCore(
    0,
    db().withPlugin(
      staleAffectedUser(gone.uid, () => {
        replays++
      }),
    ),
  )
  if (operation === 'private') {
    const result = await core.textures.update(owner, texture.tid, { public: false })
    expect(result.texture).toMatchObject({ public: false, likes: 1 })
  } else {
    await core.textures.delete(owner, texture.tid)
    expect(await file()).toMatchObject({ status: 'deleting' })
  }
  expect(replays).toBe(1)
  expect(await balance(alive.uid)).toBe(before + 7)
  expect(
    (await db().selectFrom('players').select('skin_texture_id').where('id', '=', pid).executeTakeFirstOrThrow())
      .skin_texture_id,
  ).toBeNull()
  expect(
    (await db().selectFrom('users').select('avatar_texture_id').where('id', '=', alive.uid).executeTakeFirstOrThrow())
      .avatar_texture_id,
  ).toBeNull()
  await ledgerCheck()
})

test.each(['wrongSlots', 'skinDimensions', 'capeDimensions'] as const)(
  '导入的槽位不匹配或尺寸无效时 listOwned 将相应槽位置空（%s）',
  async (invalid) => {
    const skin = (await upload()).texture,
      cape = (await upload(owner, 2, true, { type: 'cape' })).texture
    const player = await core.players.create(owner, { name: 'Imported' })
    await db()
      .updateTable('players')
      .set({
        skin_texture_id: invalid === 'wrongSlots' ? cape.tid : skin.tid,
        cape_texture_id: invalid === 'wrongSlots' ? skin.tid : cape.tid,
      })
      .where('id', '=', player.pid)
      .execute()
    if (invalid !== 'wrongSlots')
      await db()
        .updateTable('texture_files')
        .set({ width: 63 })
        .where('hash', '=', invalid === 'skinDimensions' ? skin.hash : cape.hash)
        .execute()
    const [row] = await core.players.listOwned(owner.uid)
    expect(row?.skin).toEqual(
      invalid === 'capeDimensions' ? { tid: skin.tid, hash: skin.hash, type: 'steve', scale: 1 } : null,
    )
    expect(row?.cape).toEqual(invalid === 'skinDimensions' ? { tid: cape.tid, hash: cape.hash, scale: 1 } : null)
  },
)

test('改模型更新两个槽位的角色，包括错误槽位和同时使用两个槽位的导入角色', async () => {
  const { texture } = await upload(),
    other = await user('other')
  const skin = await core.players.create(owner, { name: 'Skin' }),
    cape = await core.players.create(other, { name: 'WrongCape' }),
    both = await core.players.create(other, { name: 'Both' }),
    untouched = await core.players.create(other, { name: 'Untouched' })
  for (const [pid, skinId, capeId] of [
    [skin.pid, texture.tid, null],
    [cape.pid, null, texture.tid],
    [both.pid, texture.tid, texture.tid],
    [untouched.pid, null, null],
  ] as const)
    await db()
      .updateTable('players')
      .set({ skin_texture_id: skinId, cape_texture_id: capeId, updated_at: old })
      .where('id', '=', pid)
      .execute()
  clock += 100
  await core.textures.update(owner, texture.tid, { type: 'alex' })
  const rows = await db()
    .selectFrom('players')
    .select(['id', 'skin_texture_id', 'cape_texture_id', 'updated_at'])
    .orderBy('id')
    .execute()
  for (const row of rows) expect(row.updated_at).toBe(row.id === untouched.pid ? old : toIsoTimestamp(now()))
  expect(rows.find((row) => row.id === both.pid)).toMatchObject({
    skin_texture_id: texture.tid,
    cape_texture_id: texture.tid,
  })
})

test.each([0, 80])('第一次 storage.delete 尚未完成时，第二个回收任务不能再次删除或删行（L=%s）', async (lateWindow) => {
  makeCore(lateWindow)
  const { texture } = await upload()
  await core.textures.delete(owner, texture.tid)
  clock += 21
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  storage.delete.mockImplementationOnce(async (key) => {
    entered.resolve()
    await release.promise
    objects.delete(key)
  })
  const run = recycler(),
    first = run()
  try {
    await entered.promise
    const claimId = (await file())!.claim_id
    await run()
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(await file()).toMatchObject({ status: 'deleting', claim_id: claimId, delete_confirmed_at: null })
    expect(objects.has(hash())).toBe(true)
  } finally {
    release.resolve()
    await first
  }
  if (lateWindow > 0) {
    clock += lateWindow + 1
    await core.jobs.drain()
  }
  expect(await file()).toBeUndefined()
  await upload()
  clock += 101
  await core.jobs.drain()
  expect(storage.delete).toHaveBeenCalledOnce()
  expect(await file()).toMatchObject({ status: 'active', ref_count: 1 })
  expect(objects.has(hash())).toBe(true)
})
