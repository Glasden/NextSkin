import { coreMigrations, migrateToLatest, toIsoTimestamp, upsert, writeAuthDate, type CoreDatabase } from '@nextskin/db'
import { createTestDatabase, type TestDatabase } from '@nextskin/db/testing'
import { createMemoryLogger } from '@nextskin/logging'
import type { AnyPluginDefinition } from '@nextskin/plugin-host'
import { afterEach, beforeEach } from 'vitest'
import { createCore, type CoreOptions } from '../core.ts'
import { encodeSettingValue } from '../settings/codec.ts'
import { markSiteInitialized } from '../setup/initialized.test-helper.ts'
import type { RegisterInput } from '../users/register.ts'
import type { OfficialPlugin } from './system.ts'

export function official(id: string, definition: AnyPluginDefinition): OfficialPlugin {
  return {
    definition,
    package: { name: `@test/${id}`, version: '1.0.0', nextskin: { id } },
    messages: { 'zh-CN': {}, en: {} },
  }
}

export function pluginEnvironment() {
  let database: TestDatabase<CoreDatabase>
  let core: ReturnType<typeof createCore> | undefined
  let sequence = 0
  const { logger, records: lines } = createMemoryLogger()
  const secretKey = 'plugin-tests-only-secret-key-at-least-32-characters'
  beforeEach(async () => {
    database = await createTestDatabase<CoreDatabase>()
    await migrateToLatest(database.db, coreMigrations)
    await markSiteInitialized(database.db)
    await upsert(database.db, 'settings', {
      values: {
        namespace: 'core',
        key: 'site.url',
        value: encodeSettingValue('site.url', 'https://skin.example.test', { secretKey }),
        updated_at: toIsoTimestamp(new Date()),
      },
      conflict: ['namespace', 'key'],
      update: ['value', 'updated_at'],
    })
    sequence = 0
    lines.length = 0
  })
  afterEach(async () => {
    try {
      await core?.shutdown()
    } finally {
      core = undefined
      await database?.cleanup()
    }
  })
  return {
    get db() {
      return database.db
    },
    get core() {
      if (!core) throw new Error('Call boot first')
      return core
    },
    /** SQLite 的数据库文件；其他数据库是 undefined */
    get databaseFile() {
      return database.config.dialect === 'sqlite' ? database.config.file : undefined
    },
    records: lines,
    logger,
    secretKey,
    async boot(plugins: readonly OfficialPlugin[], options: Partial<CoreOptions> = {}) {
      await core?.shutdown()
      core = createCore({
        db: database.db,
        secretKey,
        production: false,
        textureStorage: {
          list: () => Promise.resolve([]),
          listTemp: () => Promise.resolve([]),
          lateDeleteWindowMs: 0,
          write: async () => {},
          delete: async () => {},
          deleteTemp: async () => {},
          read: () => Promise.resolve(null),
        },
        ...options,
        plugins: {
          official: plugins,
          sqliteFile: database.config.dialect === 'sqlite' ? database.config.file : undefined,
          logger,
          ...options.plugins,
        },
        jobs: { logger, ...options.jobs },
      })
      await core.plugins.start()
      return core
    },
    async actor(role: 'superadmin' | 'admin' = 'superadmin') {
      const email = `actor${++sequence}@example.test`
      const now = writeAuthDate(database.db, toIsoTimestamp(new Date()))
      await database.db
        .insertInto('users')
        .values({ email, nickname: role, role, email_verified: false, created_at: now, updated_at: now })
        .execute()
      const { id: uid } = await database.db
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirstOrThrow()
      return { uid, ip: '192.0.2.1' }
    },
    input(overrides: Partial<RegisterInput> = {}): RegisterInput {
      const n = ++sequence
      return {
        email: `user${n}@example.test`,
        password: 'correct horse battery staple',
        playerName: `Player${n}`,
        ip: `192.0.2.${n}`,
        locale: 'en',
        ...overrides,
      }
    },
  }
}
