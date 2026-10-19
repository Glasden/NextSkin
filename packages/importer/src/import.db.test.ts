import { generateKeyPair } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { createLocalTextureStorage, offlineUuid } from '@nextskin/domain/importer'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'
import { reportToMarkdown } from './markdown.ts'
import type { ImportReport } from './report.ts'
import type { SourceDatabase } from './source/schema.ts'
import { createBsSchema, insertRows } from './testing/bs.ts'
import {
  createEnvironment,
  garbageHash,
  importer,
  missingHash,
  paddedCapeHash,
  pixelHash,
  pngs,
  type Environment,
} from './testing/fixtures.ts'

let env: Environment
let source: TestDatabase<SourceDatabase>
let target: TestDatabase<CoreDatabase>
let run: ReturnType<typeof importer>
let signingKey: string

// 4096 位的 RSA 要随机找大素数，耗时没有上限；pnpm check 并行跑时 CI 上会超过钩子默认的 10 秒
beforeAll(async () => {
  const key = promisify(generateKeyPair)('rsa', {
    modulusLength: 4096,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  env = await createEnvironment()
  signingKey = (await key).privateKey
}, 60_000)
afterAll(async () => env?.cleanup())
beforeEach(async () => {
  await env.resetStorage()
  source = await createTestDatabase<SourceDatabase>()
  target = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(target.db, coreMigrations)
  // 旧站的时区与测试进程的时区（Asia/Shanghai）不同，按进程时区解释旧站时间的错误会暴露出来
  run = importer(env, source, target, { timeZone: 'Asia/Tokyo', passwordMethod: 'SALTED2MD5', salt: 'pepper' })
})
afterEach(async () => {
  await source?.cleanup()
  await target?.cleanup()
})

const BCRYPT = '$2y$10$lkVsMF1jleJ9XJczznXCfOnFkh98MgJbIf6.Z7hDX/LfNN.mW5Qka'
const ARGON = '$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQxMjM0$7Jx6k2k2bH1sB2y8XG8fJb0h8fXqVf2Q8wq8yQ2B3l4'
const MD5 = 'ABCDEF0123456789abcdef0123456789'

async function seedWorld(): Promise<void> {
  const db = source.db
  await createBsSchema(db, { uuidTable: 'yggdrasil-connect', descriptions: 'new' })
  const user = (uid: number, email: string, permission: number, extra: Record<string, unknown> = {}) => ({
    uid,
    email,
    nickname: `user${uid}`,
    locale: null,
    score: 100,
    avatar: 0,
    password: BCRYPT,
    ip: '127.0.0.1',
    permission,
    last_sign_at: '2020-01-03 00:00:00',
    register_at: '2020-01-02 03:04:05',
    verified: true,
    ...extra,
  })
  await insertRows(db, 'users', [
    user(1, ' Admin@Example.TEST ', 2, { score: 1000, locale: 'zh_CN', avatar: 1 }),
    user(2, 'steve@example.test', 0, { score: 500, locale: 'en', avatar: 99, password: ARGON, verified: false }),
    user(3, 'banned@example.test', -1, { score: 0, locale: 'fr_FR', ip: '2001:db8::1' }),
    user(4, 'admin2@example.test', 1, { password: MD5 }),
    user(5, 'refund@example.test', 0, { score: 10, avatar: 6 }),
    user(7, 'weird@example.test', 5, { password: 'not-a-hash' }),
  ])
  const texture = (tid: number, name: string, type: string, hash: string, extra: Record<string, unknown> = {}) => ({
    tid,
    name,
    type,
    hash,
    size: 2,
    uploader: 1,
    public: 1,
    upload_at: '2020-02-01 10:00:00',
    likes: 0,
    ...extra,
  })
  await insertRows(db, 'textures', [
    texture(1, 'Steve', 'steve', pngs.steve.hash, { likes: 3 }),
    texture(2, 'Alex', 'alex', pngs.alex.hash, { uploader: 2, public: 0, size: 3, likes: 1 }),
    texture(3, 'Cape', 'cape', pngs.narrowCape.hash, { uploader: 99 }),
    texture(4, 'Odd', 'steve', pngs.odd.hash),
    texture(5, 'Broken', 'steve', garbageHash),
    texture(6, 'Ghost', 'steve', missingHash),
    texture(7, 'Steve copy', 'steve', pngs.steve.hash, { uploader: 2, public: 0 }),
    texture(8, 'Interlaced', 'alex', pngs.interlaced.hash),
    texture(9, 'Weird', 'skin', pngs.steve.hash),
    texture(10, 'Ghost again', 'cape', missingHash),
  ])
  await insertRows(db, 'textures_description', [
    { tid: 1, description: 'A classic' },
    { tid: 5, description: 'broken' },
  ])
  const player = (pid: number, uid: number, name: string, skin: number, cape: number) => ({
    pid,
    uid,
    name,
    tid_skin: skin,
    tid_cape: cape,
    last_modified: '2020-03-04 05:06:07',
  })
  await insertRows(db, 'players', [
    player(1, 1, 'Steve', 1, 3),
    player(2, 2, 'Alex_01', 2, 0),
    player(3, 2, 'Ghosty', 6, 999),
    player(4, 99, 'Orphan', 1, 0),
    player(5, 3, 'Banned', 8, 0),
    player(6, 2, 'Hyphen', -1, 0),
  ])
  await insertRows(db, 'uuid', [
    { pid: 1, name: 'Steve', uuid: '0123456789abcdef0123456789abcdef' },
    { pid: 6, name: 'Hyphen', uuid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' },
    { pid: null, name: 'DeletedPlayer', uuid: '11111111111111111111111111111111' },
  ])
  await insertRows(db, 'user_closet', [
    { user_uid: 1, texture_tid: 1, item_name: 'my steve' },
    { user_uid: 1, texture_tid: 1, item_name: 'dup' },
    { user_uid: 2, texture_tid: 1, item_name: '' },
    { user_uid: 2, texture_tid: 5, item_name: 'broken' },
    { user_uid: 99, texture_tid: 1, item_name: 'nobody' },
    { user_uid: 2, texture_tid: 2, item_name: null },
  ])
  const report = (id: number, tid: number, reporter: number, status: number) => ({
    id,
    tid,
    uploader: 1,
    reporter,
    reason: `reason ${id}`,
    status,
    report_at: '2020-04-01 12:00:00',
  })
  await insertRows(db, 'reports', [
    report(1, 1, 2, 0),
    report(2, 1, 2, 1),
    report(3, 6, 5, 0),
    report(4, 2, 99, 2),
    report(5, 1, 1, 7),
  ])
  const client = (id: number, extra: Record<string, unknown>) => ({
    id,
    user_id: 1,
    name: `client${id}`,
    secret: null,
    provider: null,
    redirect: 'https://c.test/cb',
    personal_access_client: false,
    password_client: false,
    revoked: false,
    created_at: '2020-05-01 00:00:00',
    updated_at: '2020-05-02 00:00:00',
    ...extra,
  })
  await insertRows(db, 'oauth_clients', [
    client(1, { secret: 'secret1', redirect: 'https://a.test/cb, https://b.test/cb' }),
    client(2, { user_id: 99, revoked: true }),
    client(3, { personal_access_client: true }),
  ])
  const options: Record<string, string> = {
    version: '6.0.2',
    site_url: 'https://old.example.test/',
    site_name: 'Old Site',
    private_score_per_storage: '10',
    score_per_closet_item: '2',
    score_per_player: '50',
    score_award_per_texture: '1',
    reporter_score_modification: '-5',
    reporter_reward_score: '3',
    max_upload_file_size: '10000',
    texture_name_regexp: '/^[a-z ]+$/i',
    announcement: 'Welcome to Blessing Skin 6.0.2!',
    announcement_zh_CN: '# 公告\n<b>粗体</b>',
    announcement_en: 'Hello',
    ygg_uuid_algorithm: 'v3',
    ygg_private_key: signingKey,
    ygg_skin_domain: ' a.test, ,b.test ',
    sign_score: '5,50',
    status_code_for_private: '404',
    player_name_rule: 'cjk',
  }
  await insertRows(
    db,
    'options',
    Object.entries(options).map(([option_name, option_value]) => ({ option_name, option_value })),
  )
  await sql`create table mojang_verifications (id integer)`.execute(db)
  await insertRows(db, 'mojang_verifications', [{ id: 1 }, { id: 2 }])
}

async function targetCounts() {
  const db = target.db
  const count = async (table: 'users' | 'players' | 'textures' | 'texture_files' | 'closet_items' | 'reports') =>
    (await db.selectFrom(table).selectAll().execute()).length
  return {
    users: await count('users'),
    players: await count('players'),
    textures: await count('textures'),
    files: await count('texture_files'),
    closet: await count('closet_items'),
    reports: await count('reports'),
  }
}

const iso = (value: string) => toIsoTimestamp(new Date(value))

test('导入覆盖对照表的每一条规则，报告逐项列出', async () => {
  await seedWorld()
  const result = await run()
  expect(result.report.error).toBeNull()
  expect(result.report.blocking.items).toEqual([])
  expect(result.status).toBe('succeeded')
  const db = target.db
  const report = result.report

  // 用户：邮箱去空格转小写、权限、语言、时间按旧站时区（Asia/Tokyo）换算
  const users = await db.selectFrom('users').selectAll().orderBy('id').execute()
  expect(users.map((user) => [user.id, user.email, user.role, user.locale, user.avatar_texture_id])).toEqual([
    [1, 'admin@example.test', 'superadmin', 'zh-CN', 1],
    [2, 'steve@example.test', 'user', 'en', null],
    [3, 'banned@example.test', 'banned', null, null],
    [4, 'admin2@example.test', 'admin', null, null],
    [5, 'refund@example.test', 'user', null, null],
    [7, 'weird@example.test', 'user', null, null],
  ])
  expect(readAuthDate(users[0]!.created_at)).toBe('2020-01-01T18:04:05.000Z')
  expect(users[0]!.last_check_in_at).toBe('2020-01-02T15:00:00.000Z')
  expect(users[0]!.email_version).toBe(0)
  expect(users.map((user) => readAuthBoolean(user.email_verified))).toEqual([true, false, true, true, true, true])
  expect(users[2]!.registration_ip).toBe('2001:db8::1')
  // 材质已不存在的待处理举报：花费加回举报人的积分
  expect(users.map((user) => user.score)).toEqual([1000, 500, 0, 100, 15, 100])
  expect(report.tables.users).toMatchObject({
    source: 6,
    imported: 6,
    adjusted: { unknown_permission: 1, unsupported_locale: 1, plugin_password: 1, avatar_missing: 2 },
  })

  // 密码：bcrypt、argon2 原样，十六进制摘要按 PWD_METHOD 转成 $bs$；可打印的未知格式留给插件认领
  const accounts = await db.selectFrom('accounts').selectAll().orderBy('user_id').execute()
  expect(
    accounts.map((account) => [account.user_id, account.account_id, account.provider_id, account.password]),
  ).toEqual([
    [1, '1', 'credential', BCRYPT],
    [2, '2', 'credential', ARGON],
    [3, '3', 'credential', BCRYPT],
    [4, '4', 'credential', `$bs$salted2md5$${MD5.toLowerCase()}`],
    [5, '5', 'credential', BCRYPT],
    [7, '7', 'credential', 'not-a-hash'],
  ])
  // 积分不为 0 的写一条"导入"流水，余额等于导入的积分
  const transactions = await db.selectFrom('score_transactions').selectAll().orderBy('user_id').execute()
  expect(transactions.map((row) => [row.user_id, row.delta, row.balance, row.reason])).toEqual([
    [1, 1000, 1000, 'score.reasons.import'],
    [2, 500, 500, 'score.reasons.import'],
    [4, 100, 100, 'score.reasons.import'],
    [5, 15, 15, 'score.reasons.import'],
    [7, 100, 100, 'score.reasons.import'],
  ])

  // 材质：缺文件、解码不了、类型不认识的跳过；同一文件的多个条目共用一行 texture_files
  const textures = await db.selectFrom('textures').selectAll().orderBy('id').execute()
  expect(
    textures.map((row) => [row.id, row.hash, row.type, row.uploader_id, row.is_public, row.likes, row.score_paid]),
  ).toEqual([
    // 公开：2 KB × 1 − 上传奖励 1（旧站开着 take_back_scores_after_deletion）
    [1, pngs.steve.hash, 'steve', 1, 1, 2, 1],
    // 私有：3 KB × 10
    [2, pngs.alex.hash, 'alex', 2, 0, 1, 30],
    [3, pngs.narrowCape.hash, 'cape', null, 1, 0, 1],
    [4, pngs.odd.hash, 'steve', 1, 1, 0, 1],
    [7, pngs.steve.hash, 'steve', 2, 0, 0, 20],
    [8, pngs.interlaced.hash, 'alex', 1, 1, 0, 1],
  ])
  expect(textures[0]).toMatchObject({ name: 'Steve', description: 'A classic', created_at: '2020-02-01T01:00:00.000Z' })
  expect(report.tables.textures).toMatchObject({
    source: 10,
    imported: 6,
    skipped: { invalid_type: 1, file_undecodable: 1, file_missing: 2 },
    adjusted: { uploader_missing: 1 },
  })
  const files = await db.selectFrom('texture_files').selectAll().orderBy('hash').execute()
  const file = (hash: string) => files.find((row) => row.hash === hash)
  expect(files).toHaveLength(5)
  expect(file(pngs.steve.hash)).toMatchObject({
    pixel_hash: pixelHash(64, 64, pngs.steve.rgba),
    width: 64,
    height: 64,
    size_bytes: pngs.steve.bytes.length,
    ref_count: 2,
    status: 'active',
    claim_id: null,
  })
  // 像素相同、字节不同的旧文件各存一份，像素 hash 相同（上传查重能命中）
  expect(file(pngs.interlaced.hash)!.pixel_hash).toBe(file(pngs.steve.hash)!.pixel_hash)
  // 窄披风补宽之后算像素 hash，宽高也是规范化之后的
  expect(file(pngs.narrowCape.hash)).toMatchObject({
    pixel_hash: paddedCapeHash(pngs.narrowCape),
    width: 64,
    height: 32,
  })
  // 尺寸不合规则的照样导入，按原图算
  expect(file(pngs.odd.hash)).toMatchObject({ pixel_hash: pixelHash(100, 50, pngs.odd.rgba), width: 100, height: 50 })
  expect(report.files).toMatchObject({
    total: 5,
    decoded: 5,
    reused: 0,
    copied: 5,
    alreadyStored: 0,
    missing: { total: 1, items: [{ hash: missingHash, tids: [6, 10] }] },
    undecodable: { total: 1, items: [{ hash: garbageHash, tids: [5] }] },
    nonconforming: { total: 1, items: [{ hash: pngs.odd.hash, type: 'steve', width: 100, height: 50 }] },
  })
  // 文件按原字节复制进存储，不重新编码
  expect((await readdir(env.storageDirectory)).filter((name) => !name.startsWith('.')).sort()).toEqual(
    [pngs.steve.hash, pngs.alex.hash, pngs.narrowCape.hash, pngs.odd.hash, pngs.interlaced.hash].sort(),
  )
  expect(new Uint8Array(await readFile(join(env.storageDirectory, pngs.interlaced.hash)))).toEqual(
    pngs.interlaced.bytes,
  )

  // 角色：用户不存在的跳过；材质不存在或被跳过的置空；UUID 按 pid、带连字符的统一格式、没有映射的按离线算法
  const players = await db.selectFrom('players').selectAll().orderBy('id').execute()
  expect(
    players.map((row) => [
      row.id,
      row.user_id,
      row.name,
      row.name_key,
      row.uuid,
      row.skin_texture_id,
      row.cape_texture_id,
    ]),
  ).toEqual([
    [1, 1, 'Steve', 'steve', '0123456789abcdef0123456789abcdef', 1, 3],
    [2, 2, 'Alex_01', 'alex_01', offlineUuid('Alex_01'), 2, null],
    [3, 2, 'Ghosty', 'ghosty', offlineUuid('Ghosty'), null, null],
    [5, 3, 'Banned', 'banned', offlineUuid('Banned'), 8, null],
    [6, 2, 'Hyphen', 'hyphen', 'aaaaaaaabbbb4ccc8dddeeeeeeeeeeee', null, null],
  ])
  expect(players[0]).toMatchObject({
    score_paid: 50,
    created_at: '2020-03-03T20:06:07.000Z',
    updated_at: '2020-03-03T20:06:07.000Z',
  })
  expect(report.tables.players).toMatchObject({
    source: 6,
    imported: 5,
    skipped: { user_missing: 1 },
    adjusted: { skin_missing: 1, cape_missing: 1 },
  })
  expect(report.uuid.counts).toEqual({ pid: 2, name: 0, override: 0, offline: 3, random: 0 })
  expect(report.uuid.generated.items.map((item) => [item.pid, item.source])).toEqual([
    [2, 'offline'],
    [3, 'offline'],
    [5, 'offline'],
  ])
  expect(report.uuid.orphanMappings).toBe(1)
  expect(report.verification).toEqual({ checked: 5, mismatches: { items: [], total: 0 } })

  // 衣柜：重复的行只留一条，名字为空用材质名，用户或材质不存在的跳过
  const closet = await db.selectFrom('closet_items').selectAll().orderBy('user_id').orderBy('texture_id').execute()
  expect(closet.map((row) => [row.user_id, row.texture_id, row.score_paid])).toEqual([
    [1, 1, 2],
    [2, 1, 2],
    [2, 2, 2],
  ])
  expect(closet.map((row) => row.name).sort()).toEqual(['Alex', 'Steve', 'my steve'].sort())
  expect(report.closet.duplicates).toBe(1)
  expect(report.tables.closet).toMatchObject({
    source: 6,
    imported: 3,
    skipped: { duplicate: 1, texture_missing: 1, user_missing: 1 },
  })
  // 收藏数按衣柜重新统计
  expect(report.likes).toEqual({ total: 1, items: [{ tid: 1, before: 3, after: 2 }] })

  // 举报：重复的只留 id 最小的一条；材质已不存在的待处理举报记为已结案
  const reports = await db.selectFrom('reports').selectAll().orderBy('id').execute()
  expect(
    reports.map((row) => [row.id, row.texture_id, row.reporter_id, row.status, row.resolution, row.score_paid]),
  ).toEqual([
    [1, 1, 2, 'pending', null, 5],
    [3, null, 5, 'resolved', 'textureDeleted', 0],
    [4, 2, null, 'rejected', null, 0],
  ])
  expect(reports[0]!.created_at).toBe('2020-04-01T03:00:00.000Z')
  expect(reports[1]!.resolved_at).not.toBeNull()
  expect(report.reports).toEqual({ duplicates: 1, autoResolved: 1, refunded: 5 })

  // OAuth 客户端：secret 为空的是公共客户端；保密客户端的 secret 存 sha256
  const clients = await db.selectFrom('oauth_clients').selectAll().orderBy('client_id').execute()
  expect(clients.map((row) => [row.client_id, row.token_endpoint_auth_method, row.user_id])).toEqual([
    ['1', 'client_secret_basic', 1],
    ['2', 'none', null],
  ])
  expect(clients[0]!.client_secret).toBe('WxFhjC5EAnh30M0JIe0Wa58Xb1BYf8kedTTdKUbbd9Y')
  const json = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value)
  expect(json(clients[0]!.redirect_uris)).toEqual(['https://a.test/cb', 'https://b.test/cb'])
  expect(clients.map((row) => [readAuthBoolean(row.disabled), readAuthBoolean(row.require_pkce)])).toEqual([
    [false, false],
    [true, true],
  ])
  expect(report.tables.oauthClients).toMatchObject({ source: 3, imported: 2, skipped: { unsupported_client: 1 } })

  // 设置：只存和默认值不同的；机密项加密
  const settings = Object.fromEntries(
    (await db.selectFrom('settings').select(['key', 'value']).execute()).map((row) => [row.key, row.value]),
  )
  expect(JSON.parse(settings['site.url']!)).toBe('https://old.example.test')
  expect(JSON.parse(settings['site.name']!)).toBe('Old Site')
  expect(JSON.parse(settings['site.timeZone']!)).toBe('Asia/Tokyo')
  expect(JSON.parse(settings['site.announcement']!)).toBe('# 公告\n<b>粗体</b>')
  expect(JSON.parse(settings['texture.maxFileSizeKb']!)).toBe(8192)
  expect(JSON.parse(settings['texture.nameRegex']!)).toBe('(?i:^[a-z ]+$)')
  expect(JSON.parse(settings['report.cost']!)).toBe(5)
  expect(JSON.parse(settings['report.reward']!)).toBe(3)
  expect(JSON.parse(settings['score.perPlayer']!)).toBe(50)
  expect(JSON.parse(settings['score.perClosetItem']!)).toBe(2)
  expect(JSON.parse(settings['checkIn.score']!)).toEqual({ min: 5, max: 50 })
  expect(JSON.parse(settings['yggdrasil.skinDomains']!)).toEqual(['a.test', 'b.test'])
  expect(JSON.parse(settings['player.nameRule']!)).toBe('cjk')
  // 和默认值相同的不存
  expect(settings['score.perKbPublic']).toBeUndefined()
  expect(settings['player.uuidAlgorithm']).toBeUndefined()
  for (const key of ['yggdrasil.signingKey', 'auth.legacyPasswordSalt']) {
    expect(JSON.parse(settings[key]!)).toMatchObject({ v: 1 })
    expect(settings[key]).not.toContain('PRIVATE KEY')
    expect(settings[key]).not.toContain('pepper')
  }
  expect(report.settings.clamped).toEqual([{ key: 'texture.maxFileSizeKb', from: '10000', to: '8192' }])
  expect(report.settings.otherLocales).toEqual(['announcement_en'])
  expect(report.settings.rawHtml).toEqual(['announcement_zh_CN'])
  expect(report.settings.notImported).toEqual([
    { option: 'score_award_per_texture', value: '1' },
    { option: 'status_code_for_private', value: '404' },
  ])

  expect(report.unknownTables).toEqual([{ name: 'mojang_verifications', rows: 2 }])
  expect(report.source).toMatchObject({ bsVersion: '6.0.2', uuidTable: 'yggdrasil-connect', timeZone: 'Asia/Tokyo' })

  // 运行记录：机密不写进去
  const run_ = await db.selectFrom('import_runs').selectAll().where('id', '=', result.runId).executeTakeFirstOrThrow()
  expect(run_).toMatchObject({ status: 'succeeded', is_dry_run: 0, entry: 'cli', started_by: null })
  expect(run_.finished_at).not.toBeNull()
  expect(JSON.parse(run_.report!)).toEqual(report)
  const sourceInfo = JSON.parse(run_.source) as Record<string, unknown>
  expect(sourceInfo).toMatchObject({ prefix: '', timeZone: 'Asia/Tokyo', texturesDirectory: env.texturesDirectory })
  expect(sourceInfo).not.toHaveProperty('password')
  expect(run_.report).not.toContain('pepper')

  const markdown = reportToMarkdown(report)
  expect(markdown).toContain('# 从 BS 导入的对账报告')
  expect(markdown).toContain('没有停止类问题，导入已经提交。')
  expect(markdown).toContain(`| 2 | Alex_01 | ${offlineUuid('Alex_01')} | 离线算法生成 |`)
  expect(markdown).toContain(`| ${missingHash} | 6、10 |`)
  expect(markdown).toContain(
    '| 材质（textures） | 10 | 6 | 类型不认识 1；文件无法解码 1；文件缺失 2 | 上传者不存在，置空 1 |',
  )
  expect(markdown).toContain('| mojang_verifications | 2 |')
  expect(markdown).not.toContain('pepper')

  // 导入后自增从最大 id 之后继续
  const nextUser = await insertReturningId(db, 'users', {
    nickname: 'new',
    email: 'new@example.test',
    email_verified: false,
    created_at: writeAuthDate(db, iso('2030-01-01T00:00:00Z')),
    updated_at: writeAuthDate(db, iso('2030-01-01T00:00:00Z')),
  })
  expect(nextUser).toBe(8)
})

/** 试跑与真正导入的报告只有时间、是否试跑和文件复制的计数不同 */
function comparable(report: ImportReport) {
  return {
    ...report,
    startedAt: null,
    finishedAt: null,
    dryRun: null,
    watermark: null,
    files: { ...report.files, copied: null, alreadyStored: null },
  }
}

test('试跑与真正导入的报告相同，最后回滚，不复制文件', async () => {
  await seedWorld()
  const dry = await run({ dryRun: true })
  expect(dry.status).toBe('succeeded')
  expect(await targetCounts()).toEqual({ users: 0, players: 0, textures: 0, files: 0, closet: 0, reports: 0 })
  expect(await target.db.selectFrom('settings').selectAll().execute()).toEqual([])
  expect((await readdir(env.storageDirectory)).filter((name) => !name.startsWith('.'))).toEqual([])
  const real = await run()
  expect(real.status).toBe('succeeded')
  // 随机生成的 UUID 两次不同；这份数据里没有
  expect(comparable(real.report)).toEqual(comparable(dry.report))
  const runs = await target.db.selectFrom('import_runs').select(['status', 'is_dry_run']).orderBy('id').execute()
  expect(runs).toEqual([
    { status: 'succeeded', is_dry_run: 1 },
    { status: 'succeeded', is_dry_run: 0 },
  ])
})

test('重跑要 --replace；结果与旧库当时一致，包括旧库里删掉的数据；文件沿用上一次的像素 hash', async () => {
  await seedWorld()
  expect((await run()).status).toBe('succeeded')
  const blocked = await run()
  expect(blocked.status).toBe('blocked')
  expect(blocked.report.blocking.items).toEqual([
    {
      code: 'target_not_empty',
      needs: 'replace',
      current: { users: 6, players: 5, textures: 6 },
      newData: null,
    },
  ])
  await source.db.deleteFrom('players').where('pid', '=', 2).execute()
  await source.db.deleteFrom('textures').where('tid', '=', 7).execute()
  await source.db.updateTable('users').set({ nickname: 'renamed' }).where('uid', '=', 2).execute()
  const rerun = await run({ replace: true })
  expect(rerun.status).toBe('succeeded')
  expect(rerun.report.target.lastImportAt).not.toBeNull()
  expect(await target.db.selectFrom('players').select('id').where('id', '=', 2).executeTakeFirst()).toBeUndefined()
  expect(await target.db.selectFrom('users').select('nickname').where('id', '=', 2).executeTakeFirst()).toEqual({
    nickname: 'renamed',
  })
  expect(
    await target.db
      .selectFrom('texture_files')
      .select('ref_count')
      .where('hash', '=', pngs.steve.hash)
      .executeTakeFirst(),
  ).toEqual({
    ref_count: 1,
  })
  expect(rerun.report.files).toMatchObject({ total: 5, decoded: 0, reused: 5, copied: 0, alreadyStored: 5 })
})

test('上一次导入之后新站产生了数据，要 --replace --force；从没导入过、却有数据的也一样', async () => {
  await seedWorld()
  // 用"新站"建的站点：有用户，从没导入过
  await target.db
    .insertInto('users')
    .values({
      id: 100,
      nickname: 'fresh',
      email: 'fresh@example.test',
      email_verified: true,
      created_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
      updated_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
    })
    .execute()
  const blocked = await run({ replace: true })
  expect(blocked.status).toBe('blocked')
  expect(blocked.report.blocking.items[0]).toMatchObject({ code: 'target_not_empty', needs: 'force' })
  // 被拦下时没有读旧库，目标库不变
  expect(await target.db.selectFrom('users').select('id').execute()).toEqual([{ id: 100 }])
  // 试跑不受限制，但报告里写明真正导入时要加的参数
  const dry = await run({ dryRun: true })
  expect(dry.status).toBe('blocked')
  expect(dry.report.tables.users.imported).toBe(6)
  expect(await target.db.selectFrom('users').select('id').execute()).toEqual([{ id: 100 }])

  expect((await run({ replace: true, force: true })).status).toBe('succeeded')
  expect(await target.db.selectFrom('users').select('id').where('id', '=', 100).executeTakeFirst()).toBeUndefined()

  // 导入之后有人在新站登录了
  await target.db
    .insertInto('sessions')
    .values({
      token: 'session',
      user_id: 1,
      expires_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
      created_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
      updated_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
    })
    .execute()
  const again = await run({ replace: true })
  expect(again.report.blocking.items[0]).toMatchObject({
    code: 'target_not_empty',
    needs: 'force',
    newData: { sessions: 1 },
  })
  expect((await run({ replace: true, force: true })).status).toBe('succeeded')
  expect(await target.db.selectFrom('sessions').selectAll().execute()).toEqual([])
})

test('停止类问题一次报告全部，目标库保持上一次导入的状态', async () => {
  await seedWorld()
  expect((await run()).status).toBe('succeeded')
  const before = await targetCounts()
  await insertRows(source.db, 'users', [
    {
      uid: 20,
      email: 'STEVE@example.test ',
      nickname: 'dup',
      score: 0,
      password: 'x',
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    },
  ])
  await insertRows(source.db, 'players', [{ pid: 20, uid: 1, name: 'STEVE', last_modified: '2020-01-01 00:00:00' }])
  await insertRows(source.db, 'options', [{ option_name: 'custom_player_name_regexp', option_value: '/^\\w+$/x' }])
  const result = await run({ replace: true })
  expect(result.status).toBe('blocked')
  expect(result.report.blocking.items.map((issue) => issue.code).sort()).toEqual(
    ['duplicate_email', 'duplicate_player_name', 'regex_unsupported'].sort(),
  )
  expect(result.report.blocking.items).toContainEqual({
    code: 'duplicate_email',
    email: 'steve@example.test',
    uids: [2, 20],
  })
  expect(await targetCounts()).toEqual(before)
  expect(await target.db.selectFrom('users').select('id').where('id', '=', 20).executeTakeFirst()).toBeUndefined()
})

test('中途出错和取消都整体回滚，运行记录标明结果', async () => {
  await seedWorld()
  const broken = await run({
    storage: { ...createLocalTextureStorage(env.storageDirectory), write: () => Promise.reject(new Error('磁盘满了')) },
  })
  expect(broken.status).toBe('failed')
  expect(broken.report.error).toBe('磁盘满了')
  expect(await targetCounts()).toEqual({ users: 0, players: 0, textures: 0, files: 0, closet: 0, reports: 0 })

  const controller = new AbortController()
  const cancelled = await run({
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.stage === 'players') controller.abort()
    },
  })
  expect(cancelled.status).toBe('cancelled')
  expect(await targetCounts()).toEqual({ users: 0, players: 0, textures: 0, files: 0, closet: 0, reports: 0 })
  // 文件在事务之外复制，回滚后留在存储里，由 core:texture-sweep 回收（ADR-0029）
  expect((await readdir(env.storageDirectory)).filter((name) => !name.startsWith('.'))).toHaveLength(5)
  const runs = await target.db.selectFrom('import_runs').select(['status', 'finished_at']).orderBy('id').execute()
  expect(runs.map((row) => row.status)).toEqual(['failed', 'cancelled'])
  expect(runs.every((row) => row.finished_at !== null)).toBe(true)
})

test('没有 .env 时遇到十六进制摘要的密码哈希就停止', async () => {
  await seedWorld()
  const result = await run({ passwordMethod: null })
  expect(result.status).toBe('blocked')
  expect(result.report.blocking.items).toEqual([{ code: 'password_method_required', uids: [4], total: 1 }])
})

test.each([
  { passwordMethod: 'SALTED2MD5', algorithm: 'salted2md5', digest: MD5, prefix: '' },
  { passwordMethod: 'SALTED2SHA512', algorithm: 'saltedsha512', digest: 'AB'.repeat(64), prefix: 'bs_' },
])(
  'authme-integration 的 $passwordMethod 独立盐打包，空盐沿用 BS 格式',
  async ({ passwordMethod, algorithm, digest, prefix }) => {
    await createBsSchema(source.db, { prefix })
    await source.db.schema
      .alterTable(prefix + 'users')
      .addColumn('salt', 'varchar(6)', (column) => column.notNull().defaultTo(''))
      .execute()
    await insertRows(
      source.db,
      prefix + 'users',
      [
        { password: digest, salt: 'Ab12z9' },
        { password: digest, salt: '' },
        { password: digest, salt: 'bad!$' },
        { password: 'ab', salt: 'Ab12z9' },
        { password: BCRYPT, salt: 'bad!$' },
        { password: ARGON, salt: 'bad!$' },
      ].map((password, index) => ({
        uid: index + 1,
        email: `user${index + 1}@example.test`,
        score: 0,
        ip: '',
        last_sign_at: '2020-01-01 00:00:00',
        register_at: '2020-01-01 00:00:00',
        ...password,
      })),
    )

    const result = await run({ passwordMethod, prefix })
    expect(result.status).toBe('succeeded')
    expect(result.report.tables.users.adjusted).toEqual({ authme_password: 1, unrecognized_password: 2 })
    const accounts = await target.db.selectFrom('accounts').select(['user_id', 'password']).orderBy('user_id').execute()
    expect(accounts).toEqual([
      { user_id: 1, password: `$authme$${algorithm}$Ab12z9$${digest.toLowerCase()}` },
      { user_id: 2, password: `$bs$${passwordMethod.toLowerCase()}$${digest.toLowerCase()}` },
      { user_id: 5, password: BCRYPT },
      { user_id: 6, password: ARGON },
    ])
    expect(reportToMarkdown(result.report)).toContain(
      '密码是 AuthMe 的格式，原样导入；启用官方插件"AuthMe 密码"后能用旧密码登录，登录后换成新算法 1',
    )
  },
)

test('SHA256 保留 AuthMe 的 $SHA$ 哈希，纯摘要仍按 BS 格式导入，不读独立盐', async () => {
  await createBsSchema(source.db)
  await source.db.schema
    .alterTable('users')
    .addColumn('salt', 'varchar(6)', (column) => column.notNull().defaultTo(''))
    .execute()
  const digest = 'AB'.repeat(32)
  const authme = `$SHA$Ab12z9$${digest}`
  await insertRows(
    source.db,
    'users',
    [authme, digest].map((password, index) => ({
      uid: index + 1,
      email: `user${index + 1}@example.test`,
      score: 0,
      password,
      salt: 'bad!$',
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    })),
  )

  const result = await run({ passwordMethod: 'SHA256' })
  expect(result.status).toBe('succeeded')
  expect(result.report.tables.users.adjusted).toEqual({ authme_password: 1 })
  expect(await target.db.selectFrom('accounts').select(['user_id', 'password']).orderBy('user_id').execute()).toEqual([
    { user_id: 1, password: authme },
    { user_id: 2, password: `$bs$sha256$${digest.toLowerCase()}` },
  ])
})

test('未知的可打印密码格式留给插件，无效值和 NextSkin 自有格式不导入密码', async () => {
  await createBsSchema(source.db)
  const preserved = ['$pbkdf2-sha256$29000$salt$digest', '!abcdef!', '$plugin$' + 'x'.repeat(247)]
  const rejected = [
    '',
    'short',
    ' hash-with-leading-space',
    'hash-with space',
    'hash-with-tab\t',
    'hash-with-newline\n',
    '$bs$md5$' + MD5.toLowerCase(),
    '$authme$salted2md5$Ab12z9$' + MD5.toLowerCase(),
    'a'.repeat(32) + ':' + 'b'.repeat(128),
    '$plugin$非ASCII',
    '$plugin$\x7f',
  ]
  await insertRows(
    source.db,
    'users',
    [...preserved, ...rejected].map((password, index) => ({
      uid: index + 1,
      email: `user${index + 1}@example.test`,
      score: 0,
      password,
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    })),
  )

  const result = await run({ passwordMethod: null })
  expect(result.status).toBe('succeeded')
  expect(result.report.tables.users.adjusted).toEqual({ plugin_password: 3, unrecognized_password: 11 })
  expect(await target.db.selectFrom('accounts').select(['user_id', 'password']).orderBy('user_id').execute()).toEqual(
    preserved.map((password, index) => ({ user_id: index + 1, password })),
  )
  expect(reportToMarkdown(result.report)).toContain(
    '密码哈希核心认不出，原样导入；装上认得这种格式的密码插件后能用旧密码登录，否则用找回密码重设 3',
  )
})

test('表前缀和旧版 texture-description 的表', async () => {
  await createBsSchema(source.db, { prefix: 'bs_', uuidTable: 'none', descriptions: 'old' })
  await insertRows(source.db, 'bs_users', [
    {
      uid: 1,
      email: 'a@example.test',
      score: 0,
      password: BCRYPT,
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    },
  ])
  await insertRows(source.db, 'bs_textures', [
    {
      tid: 1,
      name: 'S',
      type: 'steve',
      hash: pngs.steve.hash,
      size: 1,
      uploader: 1,
      public: 1,
      upload_at: '2020-01-01 00:00:00',
    },
  ])
  await insertRows(source.db, 'bs_textures_desc', [{ tid: 1, desc: 'old plugin' }])
  await insertRows(source.db, 'bs_players', [
    { pid: 1, uid: 1, name: 'Steve', tid_skin: 1, last_modified: '2020-01-01 00:00:00' },
  ])
  const result = await run({ prefix: 'bs_' })
  expect(result.status).toBe('succeeded')
  expect(result.report.source.uuidTable).toBe('none')
  expect(await target.db.selectFrom('textures').select('description').executeTakeFirst()).toEqual({
    description: 'old plugin',
  })
  expect(await target.db.selectFrom('players').select('uuid').executeTakeFirst()).toEqual({
    uuid: offlineUuid('Steve'),
  })
  expect(result.report.unknownTables).toEqual([])
})

test('试跑和被拦下的运行不推进业务表的自增：之后新建的行从原来的编号接着来', async () => {
  await seedWorld()
  await insertRows(source.db, 'users', [
    {
      uid: 2147483000,
      email: 'big@example.test',
      score: 0,
      password: BCRYPT,
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    },
  ])
  expect((await run({ dryRun: true })).status).toBe('succeeded')
  await insertRows(source.db, 'users', [
    {
      uid: 2147483001,
      email: 'STEVE@example.test',
      score: 0,
      password: BCRYPT,
      ip: '',
      last_sign_at: '2020-01-01 00:00:00',
      register_at: '2020-01-01 00:00:00',
    },
  ])
  expect((await run()).status).toBe('blocked')
  const id = await insertReturningId(target.db, 'users', {
    nickname: 'fresh',
    email: 'fresh@example.test',
    email_verified: false,
    created_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
    updated_at: writeAuthDate(target.db, iso('2030-01-01T00:00:00Z')),
  })
  expect(id).toBe(1)
})

test('会被清空的任何业务数据都算目标库有数据；导入之后新建的 OAuth 客户端也算新站的数据', async () => {
  await seedWorld()
  // 只剩一条举报（用户、材质都删了）：从没导入过，要 --force
  await target.db
    .insertInto('reports')
    .values({ reason: 'old', status: 'rejected', created_at: iso('2030-01-01T00:00:00Z') })
    .execute()
  const onlyReport = await run({ replace: true })
  expect(onlyReport.report.blocking.items[0]).toMatchObject({ code: 'target_not_empty', needs: 'force' })
  expect(await target.db.selectFrom('reports').select('reason').execute()).toEqual([{ reason: 'old' }])
  expect((await run({ replace: true, force: true })).status).toBe('succeeded')

  await target.db.insertInto('oauth_clients').values({ client_id: 'new-client', redirect_uris: '[]' }).execute()
  const blocked = await run({ replace: true })
  expect(blocked.report.blocking.items[0]).toMatchObject({
    code: 'target_not_empty',
    needs: 'force',
    newData: { oauthClients: 1, users: 0, players: 0, textures: 0 },
  })
})

test('旧站里时间在未来的行不会被当成新站的数据', async () => {
  await seedWorld()
  await source.db.updateTable('players').set({ last_modified: '2099-01-01 00:00:00' }).execute()
  await source.db.updateTable('textures').set({ upload_at: '2099-01-01 00:00:00' }).execute()
  expect((await run()).status).toBe('succeeded')
  const rerun = await run({ replace: true })
  expect(rerun.report.blocking.items).toEqual([])
  expect(rerun.status).toBe('succeeded')
  // 导入之后在新站改了角色（换材质会更新 updated_at）：是新站的数据
  await target.db
    .updateTable('players')
    .set({ updated_at: iso('2099-06-01T00:00:00Z') })
    .where('id', '=', 1)
    .execute()
  expect((await run({ replace: true })).report.blocking.items[0]).toMatchObject({
    code: 'target_not_empty',
    needs: 'force',
    newData: { players: 1 },
  })
})

test('材质已经不存在的重复举报只留一条，只退一次花费', async () => {
  await seedWorld()
  await insertRows(source.db, 'reports', [
    { id: 6, tid: 6, uploader: 1, reporter: 5, reason: 'again', status: 0, report_at: '2020-04-02 12:00:00' },
  ])
  const result = await run()
  expect(result.report.reports).toEqual({ duplicates: 2, autoResolved: 1, refunded: 5 })
  expect(await target.db.selectFrom('users').select('score').where('id', '=', 5).executeTakeFirst()).toEqual({
    score: 15,
  })
  expect(
    (await target.db.selectFrom('reports').select('id').where('reporter_id', '=', 5).execute()).map((row) => row.id),
  ).toEqual([3])
})

test('重跑时 tid 最小的材质换了类型，重新解码，不沿用上一次的像素 hash', async () => {
  await seedWorld()
  // 同一个窄披风文件，先被一条皮肤（tid 11）引用，再被披风（tid 12）引用
  await insertRows(source.db, 'textures', [
    {
      tid: 11,
      name: 'As skin',
      type: 'steve',
      hash: pngs.narrowCape.hash,
      size: 1,
      uploader: 1,
      public: 1,
      upload_at: '2020-02-01 10:00:00',
    },
    {
      tid: 12,
      name: 'As cape',
      type: 'cape',
      hash: pngs.narrowCape.hash,
      size: 1,
      uploader: 1,
      public: 1,
      upload_at: '2020-02-01 10:00:00',
    },
  ])
  await source.db.deleteFrom('textures').where('tid', '=', 3).execute()
  expect((await run()).status).toBe('succeeded')
  const file = () =>
    target.db
      .selectFrom('texture_files')
      .select(['pixel_hash', 'width', 'height'])
      .where('hash', '=', pngs.narrowCape.hash)
      .executeTakeFirst()
  // 按皮肤规范化：尺寸不合规则，按原图
  expect(await file()).toEqual({ pixel_hash: pixelHash(22, 17, pngs.narrowCape.rgba), width: 22, height: 17 })
  await source.db.deleteFrom('textures').where('tid', '=', 11).execute()
  const rerun = await run({ replace: true })
  expect(rerun.status).toBe('succeeded')
  expect(await file()).toEqual({ pixel_hash: paddedCapeHash(pngs.narrowCape), width: 64, height: 32 })
  expect(rerun.report.files).toMatchObject({ decoded: 1, reused: 4 })
})

test('在提交前最后一次进度回调里取消，照样回滚', async () => {
  await seedWorld()
  const controller = new AbortController()
  const result = await run({
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.stage === 'commit') controller.abort()
    },
  })
  expect(result.status).toBe('cancelled')
  expect(await targetCounts()).toEqual({ users: 0, players: 0, textures: 0, files: 0, closet: 0, reports: 0 })
  const markdown = reportToMarkdown(result.report)
  expect(markdown).toContain('运行没有完成')
  expect(markdown).not.toContain('导入已经提交')
  expect(markdown).not.toContain('全部一致')
})

test('每个角色的 UUID 和来源都交给 onPlayerUuid', async () => {
  await seedWorld()
  const entries: { pid: number; uuid: string; source: string }[] = []
  const result = await run({ onPlayerUuid: (entry) => entries.push(entry) })
  const players = await target.db.selectFrom('players').select(['id', 'uuid']).orderBy('id').execute()
  expect(entries.map((entry) => [entry.pid, entry.uuid])).toEqual(players.map((row) => [row.id, row.uuid]))
  expect(entries.map((entry) => entry.source)).toEqual(['pid', 'offline', 'offline', 'offline', 'pid'])
  expect(result.report.uuid.counts.pid).toBe(2)
})

test('超过 2^53 的 OAuth 客户端 id 原样成为 client_id', async () => {
  await seedWorld()
  await source.db.deleteFrom('oauth_clients').execute()
  await insertRows(source.db, 'oauth_clients', [
    {
      id: '9007199254740993',
      user_id: 1,
      name: 'big',
      secret: null,
      redirect: 'https://c.test/cb',
      personal_access_client: false,
      password_client: false,
      revoked: false,
    },
  ])
  expect((await run()).status).toBe('succeeded')
  expect(await target.db.selectFrom('oauth_clients').select('client_id').execute()).toEqual([
    { client_id: '9007199254740993' },
  ])
})

test('首页设置写入并在重导时清除旧值，报告显示旧站描述和版权原文', async () => {
  await seedWorld()
  const description = '旧站描述 <b>纯文本</b>'
  const metaDescription = '旧站另一份 SEO 描述'
  const copyright = '<a href="https://beian.miit.gov.cn/">京ICP备12345678号</a>'
  await insertRows(source.db, 'options', [
    { option_name: 'site_description_zh_CN', option_value: description },
    { option_name: 'meta_keywords', option_value: ' Minecraft, ，皮肤, ' },
    { option_name: 'meta_description', option_value: metaDescription },
    { option_name: 'copyright_text', option_value: copyright },
  ])
  const result = await run()
  expect(result.status).toBe('succeeded')
  const settings = await target.db
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('key', 'in', ['site.description', 'site.keywords'])
    .execute()
  expect(Object.fromEntries(settings.map(({ key, value }) => [key, JSON.parse(value)]))).toEqual({
    'site.description': description,
    'site.keywords': ['Minecraft', '皮肤'],
  })
  const markdown = reportToMarkdown(result.report)
  expect(markdown).toContain(metaDescription)
  expect(markdown).toContain(copyright)
  expect(markdown).toContain('改写成 Markdown 后填进 site.footer')
  await source.db
    .updateTable('options')
    .set({ option_value: 'Open-source PHP Minecraft Skin Hosting Service' })
    .where('option_name', '=', 'site_description_zh_CN')
    .execute()
  await source.db.updateTable('options').set({ option_value: '' }).where('option_name', '=', 'meta_keywords').execute()
  expect((await run({ replace: true, force: true })).status).toBe('succeeded')
  expect(
    await target.db
      .selectFrom('settings')
      .select('key')
      .where('key', 'in', ['site.description', 'site.keywords'])
      .execute(),
  ).toEqual([])
})
