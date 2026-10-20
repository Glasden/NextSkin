import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { createTestDatabase } from '@nextskin/db/testing'
import type { Kysely } from 'kysely'
import { sha256 } from '../auth/auth.ts'
import { createCore } from '../core.ts'
import { playerReference, SELECT_SCOPE } from './scopes.ts'

let sequence = 0
export async function seedOAuth(db: Kysely<CoreDatabase>, uid: number, pid: number | null = null, clientId = 'shared') {
  const key = `oauth-fixture-${++sequence}`
  const created = writeAuthDate(db, toIsoTimestamp(new Date('2026-01-01T00:00:00Z')))
  const expires = writeAuthDate(db, toIsoTimestamp(new Date('2040-01-01T00:00:00Z')))
  const reference_id = pid === null ? null : playerReference(pid)
  const values = {
    user_id: uid,
    client_id: clientId,
    scopes: JSON.stringify(['openid', SELECT_SCOPE]),
    reference_id,
    created_at: created,
    expires_at: expires,
  }
  const refresh = await insertReturningId(db, 'oauth_refresh_tokens', { ...values, token: sha256(`${key}-refresh`) })
  await db
    .insertInto('oauth_access_tokens')
    .values({ ...values, token: sha256(`${key}-access`), refresh_id: refresh })
    .execute()
  await db
    .insertInto('oauth_consents')
    .values({
      user_id: uid,
      client_id: clientId,
      reference_id,
      scopes: values.scopes,
      created_at: created,
      updated_at: created,
    })
    .execute()
  for (const status of ['pending', 'approved']) {
    const code = `${key}-${status}`
    await db
      .insertInto('device_codes')
      .values({
        device_code: code,
        user_code: code,
        user_id: String(uid),
        client_id: clientId,
        oauth_client_id: clientId,
        status,
        expires_at: expires,
      })
      .execute()
    if (pid !== null)
      await db
        .insertInto('device_code_selections')
        .values({ device_code: code, user_id: uid, player_id: pid, created_at: toIsoTimestamp(new Date()) })
        .execute()
  }
}

export async function oauthFixture() {
  const database = await createTestDatabase<CoreDatabase>()
  const db = database.db
  await migrateToLatest(db, coreMigrations)
  let time = new Date('2030-01-01T00:00:00Z')
  const now = () => time
  const core = createCore({
    db,
    now,
    secretKey: 'oauth-test-only-secret-key-at-least-32-characters',
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
    mailTransport: { send: () => Promise.resolve({ messageId: null }) },
  })
  async function user(name: string) {
    return insertReturningId(db, 'users', {
      nickname: name,
      email: `${name}@example.test`,
      email_verified: true,
      created_at: writeAuthDate(db, toIsoTimestamp(now())),
      updated_at: writeAuthDate(db, toIsoTimestamp(now())),
    })
  }
  async function player(uid: number, name: string) {
    return insertReturningId(db, 'players', {
      user_id: uid,
      name,
      name_key: name.toLowerCase(),
      uuid: (++sequence).toString(16).padStart(32, '0'),
      created_at: toIsoTimestamp(now()),
      updated_at: toIsoTimestamp(now()),
    })
  }
  async function client(name: string) {
    const clientId = `oauth-test-${name}-${++sequence}`
    const id = await insertReturningId(db, 'oauth_clients', { client_id: clientId, name, redirect_uris: '[]' })
    return { id, clientId }
  }
  async function device(
    input: {
      uid?: number | null
      status?: string
      scope?: string
      clientId?: string
      expires?: number
      code?: string
    } = {},
  ) {
    const code = input.code ?? 'ABCDEFGH'
    const id = await insertReturningId(db, 'device_codes', {
      device_code: `device-${++sequence}`,
      user_code: code,
      user_id: input.uid == null ? null : String(input.uid),
      status: input.status ?? 'pending',
      scope: input.scope ?? `openid ${SELECT_SCOPE}`,
      client_id: input.clientId ?? 'shared',
      oauth_client_id: input.clientId ?? 'shared',
      expires_at: writeAuthDate(db, toIsoTimestamp(new Date(time.getTime() + (input.expires ?? 600_000)))),
    })
    return db.selectFrom('device_codes').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  }
  async function clear() {
    await db.deleteFrom('device_codes').execute()
    await db.deleteFrom('device_code_selections').execute()
    await db.deleteFrom('users').execute()
    await db.deleteFrom('oauth_clients').where('client_id', '!=', 'shared').execute()
    await db.updateTable('oauth_clients').set({ disabled: false }).where('client_id', '=', 'shared').execute()
    await db.deleteFrom('settings').execute()
    time = new Date('2030-01-01T00:00:00Z')
  }
  return {
    db,
    core,
    user,
    player,
    client,
    device,
    clear,
    now,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms)
    },
    cleanup: async () => {
      await core.shutdown()
      await database.cleanup()
    },
  }
}
