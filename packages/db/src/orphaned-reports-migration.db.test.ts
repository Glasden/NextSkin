import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  coreMigrations,
  insertReturningId,
  migrateToLatest,
  toIsoTimestamp,
  writeAuthDate,
  type CoreDatabase,
} from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

// 迁移 0032：0030 到 0031 之间留下的、指向已删除材质的待处理举报按“上传者自己删除”结案（ADR-0027）
let database: TestDatabase<CoreDatabase>

beforeAll(async () => {
  database = await createTestDatabase<CoreDatabase>()
})
afterAll(async () => database?.cleanup())

test('指向已删除材质的待处理举报结案，其余举报不动', async () => {
  const { db } = database
  const before = Object.fromEntries(
    Object.entries(coreMigrations).filter(([name]) => name < '0032_resolve_orphaned_reports'),
  )
  await migrateToLatest(db, before)
  const timestamp = toIsoTimestamp(new Date('2026-10-01T00:00:00.000Z'))
  const reporter = await insertReturningId(db, 'users', {
    nickname: '举报人',
    email: 'reporter@example.test',
    email_verified: true,
    created_at: writeAuthDate(db, timestamp),
    updated_at: writeAuthDate(db, timestamp),
  })
  await db
    .insertInto('texture_files')
    .values({
      hash: 'a'.repeat(64),
      pixel_hash: 'b'.repeat(64),
      width: 64,
      height: 64,
      size_bytes: 1024,
      ref_count: 1,
      status: 'active',
      status_changed_at: timestamp,
      created_at: timestamp,
    })
    .execute()
  const tid = await insertReturningId(db, 'textures', {
    hash: 'a'.repeat(64),
    name: '还在的材质',
    type: 'steve',
    uploader_id: null,
    is_public: 1,
    created_at: timestamp,
    updated_at: timestamp,
  })
  const report = (texture_id: number | null, status: 'pending' | 'rejected') => ({
    texture_id,
    uploader_id: null,
    reporter_id: reporter,
    reason: '理由',
    score_paid: 5,
    status,
    resolution: status === 'rejected' ? ('dismissed' as const) : null,
    resolved_at: status === 'rejected' ? timestamp : null,
    created_at: timestamp,
  })
  const orphan = await insertReturningId(db, 'reports', report(null, 'pending'))
  const pending = await insertReturningId(db, 'reports', report(tid, 'pending'))
  const rejected = await insertReturningId(db, 'reports', report(null, 'rejected'))

  expect(await migrateToLatest(db, coreMigrations)).toEqual(['0032_resolve_orphaned_reports'])
  const rows = await db
    .selectFrom('reports')
    .select(['id', 'status', 'resolution', 'resolver_id', 'resolved_at', 'score_paid'])
    .orderBy('id')
    .execute()
  expect(rows.find((row) => row.id === orphan)).toMatchObject({
    status: 'resolved',
    resolution: 'textureDeleted',
    resolver_id: null,
    score_paid: 5,
  })
  expect(rows.find((row) => row.id === orphan)!.resolved_at).not.toBeNull()
  expect(rows.find((row) => row.id === pending)).toMatchObject({
    status: 'pending',
    resolution: null,
    resolved_at: null,
  })
  expect(rows.find((row) => row.id === rejected)).toMatchObject({
    status: 'rejected',
    resolution: 'dismissed',
    resolved_at: timestamp,
  })
  // 积分不经过迁移修改（ADR-0021）
  expect(await db.selectFrom('users').select('score').where('id', '=', reporter).executeTakeFirstOrThrow()).toEqual({
    score: 0,
  })
})
