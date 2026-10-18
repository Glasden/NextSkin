import { createCipheriv, hkdfSync } from 'node:crypto'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import {
  createCore,
  encodeSettingValue,
  coreSettingsRegistry,
  type Core,
  type CoreSettingKey,
  type CoreSettingValue,
} from './index.ts'

const secretKey = 'test-only-secret-key-with-at-least-32-characters'
const timestamp = toIsoTimestamp(new Date('2026-01-02T03:04:05.678Z'))
const hash = 'a'.repeat(64)
const uuid = '0123456789abcdef0123456789abcdef'

// 错误消息只写键名、不写值（不变量 11），所以按整条消息精确匹配
const readFailure = (key: string) =>
  new RegExp(
    `^设置项 ${key.replaceAll('.', '\\.')} 读取失败：存储的值格式不对，或者 NEXTSKIN_SECRET 与写入时不同；请在后台重新设置这一项$`,
  )

let database: TestDatabase<CoreDatabase>
let core: Core
let owner: number
let skin: number
let cape: number
const bytes = Uint8Array.from([137, 80, 78, 71])

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
  await migrateToLatest(database.db, coreMigrations)
  core = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: {
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(bytes),
    },
  })
})
afterAll(async () => database?.cleanup())
beforeEach(async () => {
  const db = database.db
  await db.deleteFrom('settings').execute()
  await db.deleteFrom('players').execute()
  await db.deleteFrom('textures').execute()
  await db.deleteFrom('texture_files').execute()
  await db.deleteFrom('users').execute()
  owner = await insertReturningId(db, 'users', {
    nickname: 'Owner',
    email: 'owner@example.test',
    email_verified: false,
    created_at: writeAuthDate(db, timestamp),
    updated_at: writeAuthDate(db, timestamp),
  })
  await db
    .insertInto('texture_files')
    .values({
      hash,
      pixel_hash: hash,
      width: 64,
      height: 64,
      size_bytes: bytes.length,
      ref_count: 2,
      status: 'active',
      status_changed_at: timestamp,
      created_at: timestamp,
    })
    .execute()
  skin = await insertReturningId(db, 'textures', {
    hash,
    name: 'Skin',
    type: 'alex',
    uploader_id: owner,
    is_public: 0,
    created_at: timestamp,
    updated_at: timestamp,
  })
  cape = await insertReturningId(db, 'textures', {
    hash,
    name: 'Cape',
    type: 'cape',
    uploader_id: owner,
    is_public: 1,
    created_at: timestamp,
    updated_at: timestamp,
  })
  await db
    .insertInto('players')
    .values({
      user_id: owner,
      name: 'Alice',
      name_key: 'alice',
      uuid,
      skin_texture_id: skin,
      cape_texture_id: cape,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .execute()
})

async function store(key: CoreSettingKey, value: string, namespace = 'core') {
  await database.db.insertInto('settings').values({ namespace, key, value, updated_at: timestamp }).execute()
}

test('角色连接用户和两种材质，忽略名字大小写、仅忽略末尾空格', async () => {
  const player = await core.players.findByName('ALICE  ')
  expect(player?.pid).toBeGreaterThan(0)
  expect(player).toEqual({
    pid: player?.pid,
    name: 'Alice',
    uuid,
    updatedAt: timestamp,
    ownerBanned: false,
    skin: { tid: skin, hash, type: 'alex' },
    cape: { tid: cape, hash },
  })
  for (const name of [' Alice', '', '   ', 'Alice\t', 'Alice\u00a0', 'Nobody']) {
    expect(await core.players.findByName(name)).toBeNull()
  }
  await database.db.updateTable('players').set({ name: 'Dot.Name', name_key: 'dot.name' }).execute()
  expect((await core.players.findByName('DOT.NAME'))?.name).toBe('Dot.Name')
  await database.db.updateTable('players').set({ name: ' Alice', name_key: ' alice' }).execute()
  expect((await core.players.findByName(' ALICE '))?.name).toBe(' Alice')
  expect(await core.players.findByName('Alice')).toBeNull()
})

test('UUID 查找接受大写和末尾空格，拒绝连字符、其他空白和格式错误', async () => {
  expect((await core.players.findByUuid(uuid.toUpperCase() + '  '))?.name).toBe('Alice')
  for (const value of [
    uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    ' ' + uuid,
    uuid + '\t',
    '0'.repeat(32),
    '',
    'g'.repeat(32),
  ]) {
    expect(await core.players.findByUuid(value)).toBeNull()
  }
})

test('封禁状态和空皮肤、空披风保留在查询视图', async () => {
  await database.db.updateTable('users').set({ role: 'banned' }).where('id', '=', owner).execute()
  await database.db.updateTable('players').set({ skin_texture_id: null }).execute()
  expect(await core.players.findByName('alice')).toMatchObject({ ownerBanned: true, skin: null, cape: { tid: cape } })
  await database.db.updateTable('players').set({ cape_texture_id: null }).execute()
  expect(await core.players.findByUuid(uuid)).toMatchObject({ ownerBanned: true, skin: null, cape: null })
})

test('文件键逐字比较，只允许 active，读文件保持字节', async () => {
  expect(await core.textures.findFile(hash)).toEqual({ hash, sizeBytes: bytes.length, createdAt: timestamp })
  expect((await core.textures.readFile(hash))?.bytes).toEqual(bytes)
  for (const value of [hash.toUpperCase(), hash + ' ', 'not-a-hash'])
    expect(await core.textures.findFile(value)).toBeNull()
  for (const status of ['pending', 'deleting'] as const) {
    await database.db.updateTable('texture_files').set({ status }).execute()
    expect(await core.textures.findFile(hash)).toBeNull()
    expect(await core.textures.readFile(hash)).toBeNull()
  }
  await database.db.updateTable('texture_files').set({ status: 'active' }).execute()
  const missing = createCore({
    db: database.db,
    secretKey,
    production: false,
    textureStorage: {
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  expect(await missing.textures.readFile(hash)).toBeNull()
})

test('设置缺省值来自注册表；namespace 隔离，读取多个存储值', async () => {
  const keys = Object.keys(coreSettingsRegistry) as CoreSettingKey[]
  expect(await core.settings.read(keys)).toEqual(
    Object.fromEntries(keys.map((key) => [key, coreSettingsRegistry[key].default])),
  )
  await store('site.name', encodeSettingValue('site.name', 'Test Site', { secretKey }))
  await store('cache.publicMaxAge', encodeSettingValue('cache.publicMaxAge', 0, { secretKey }))
  await store('site.name', '"Other namespace"', 'plugin:example')
  expect(await core.settings.read(['site.name', 'cache.publicMaxAge', 'site.url'])).toEqual({
    'site.name': 'Test Site',
    'cache.publicMaxAge': 0,
    'site.url': '',
  })
  expect(await core.settings.read([])).toEqual({})
})

test.each(['not-json-sensitive-value', '123', '{"secret":"sensitive-value"}'])(
  '无效存储设置不泄露值',
  async (stored) => {
    await store('site.name', stored)
    await expect(core.settings.read(['site.name'])).rejects.toThrow(readFailure('site.name'))
  },
)

test.each([
  ['site.url', 'ftp://example.test'],
  ['site.url', 'plain-text'],
  ['cache.publicMaxAge', -1],
  ['cache.publicMaxAge', 0.5],
  ['yggdrasil.profileSearchLimit', 0],
  ['yggdrasil.skinDomains', [1]],
  ['yggdrasil.apiLocationIndication', 1],
] as const)('编码 %s 时校验类型', (key, value) => {
  expect(() => encodeSettingValue(key, value as CoreSettingValue<typeof key>, { secretKey })).toThrow(
    `设置项 ${key} 的值不符合它的类型；请检查要写入的值`,
  )
})

test('机密设置加密后可读；随机 IV；错误密钥、明文和篡改均失败', async () => {
  const key = 'yggdrasil.signingKey'
  const value = 'test-sensitive-value'
  const encoded = encodeSettingValue(key, value, { secretKey })
  expect(encoded.includes(value)).toBe(false)
  expect(encoded === encodeSettingValue(key, value, { secretKey })).toBe(false)
  await store(key, encoded)
  expect((await core.settings.read([key]))[key] === value).toBe(true)
  const wrongKey = createCore({
    db: database.db,
    secretKey: 'wrong-key'.repeat(8),
    production: false,
    textureStorage: {
      lateDeleteWindowMs: 0,
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      deleteTemp: () => Promise.resolve(),
      read: () => Promise.resolve(null),
    },
  })
  await expect(wrongKey.settings.read([key])).rejects.toThrow(readFailure('yggdrasil.signingKey'))
  for (const field of ['data', 'iv', 'tag'] as const) {
    const envelope = JSON.parse(encoded) as Record<string, string | number>
    const data = Buffer.from(envelope[field] as string, 'base64')
    data[0] = data[0]! ^ 1
    envelope[field] = data.toString('base64')
    await database.db
      .updateTable('settings')
      .set({ value: JSON.stringify(envelope) })
      .where('key', '=', key)
      .execute()
    await expect(core.settings.read([key])).rejects.toThrow(readFailure('yggdrasil.signingKey'))
  }
  for (const invalid of [JSON.stringify(value), '{"v":2}', '{"v":1,"iv":"!","tag":"!","data":"!"}']) {
    await database.db.updateTable('settings').set({ value: invalid }).where('key', '=', key).execute()
    await expect(core.settings.read([key])).rejects.toThrow(readFailure('yggdrasil.signingKey'))
  }
})

test.each(['other:yggdrasil.signingKey', 'core:anotherKey'])('AAD 绑定 namespace 和 key（%s）', async (wrongAad) => {
  // 构造由相同密钥加密、但来自另一个 namespace/key 的合法 GCM 信封。
  const key = Buffer.from(
    hkdfSync('sha256', secretKey, 'NextSkin settings encryption v1', 'core settings AES-256-GCM', 32),
  )
  const iv = Buffer.alloc(12, 1)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(wrongAad))
  const data = Buffer.concat([cipher.update('null', 'utf8'), cipher.final()])
  await store(
    'yggdrasil.signingKey',
    JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }),
  )
  await expect(core.settings.read(['yggdrasil.signingKey'])).rejects.toThrow(readFailure('yggdrasil.signingKey'))
})

test('createCore 和 encodeSettingValue 都立即拒绝过短的 secretKey', () => {
  expect(() =>
    createCore({
      db: database.db,
      secretKey: 'short',
      production: false,
      textureStorage: {
        lateDeleteWindowMs: 0,
        write: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        deleteTemp: () => Promise.resolve(),
        read: () => Promise.resolve(null),
      },
    }),
  ).toThrow('NEXTSKIN_SECRET 设为至少 32 个字符')
  expect(() => encodeSettingValue('site.name', 'valid', { secretKey: 'short' })).toThrow(
    'NEXTSKIN_SECRET 设为至少 32 个字符',
  )
})

test.each([
  ['core ', 'site.name'],
  ['core', 'site.name '],
])('设置 namespace/key 必须逐字匹配（%j / %j）', async (namespace, key) => {
  // MySQL 的 SQL 比较会命中这些带末尾空格的行；不能让它们覆盖 core 的默认值。
  await database.db.insertInto('settings').values({ namespace, key, value: '123', updated_at: timestamp }).execute()
  expect(await core.settings.read(['site.name'])).toEqual({ 'site.name': 'NextSkin' })
})

test('坏设置只在读取该键时失败，不影响其他设置查询', async () => {
  await store('yggdrasil.skinDomains', '[1]')
  expect(await core.settings.read(['cache.publicMaxAge'])).toEqual({ 'cache.publicMaxAge': 31536000 })
  await expect(core.settings.read(['yggdrasil.skinDomains'])).rejects.toThrow(readFailure('yggdrasil.skinDomains'))
})
