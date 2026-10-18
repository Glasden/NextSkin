// 一个按 BS 6.0.2 表结构建的 SQLite 旧站（库文件、材质目录和 .env），给网页导入的 e2e 和手动检查用（ADR-0031"测试"）。
// 故意留了一处 UUID 冲突（Alex 在 uuid 表里有两个值），用来走"处理冲突后重新试跑"
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDatabase } from '@nextskin/db'
import type { SourceDatabase } from '../source/schema.ts'
import { createBsSchema, insertRows } from './bs.ts'
import { pngs } from './fixtures.ts'
import { OLD_SITE, OLD_SITE_BCRYPT } from './old-site.ts'

export interface BsSqliteSite {
  file: string
  texturesDirectory: string
  envFile: string
}

export async function createBsSqliteSite(directory: string): Promise<BsSqliteSite> {
  const file = join(directory, 'database.sqlite')
  const texturesDirectory = join(directory, 'storage', 'textures')
  await mkdir(texturesDirectory, { recursive: true })
  for (const png of [pngs.steve, pngs.narrowCape]) await writeFile(join(texturesDirectory, png.hash), png.bytes)

  const db = createDatabase<SourceDatabase>({ dialect: 'sqlite', file })
  try {
    await createBsSchema(db, { uuidTable: 'yggdrasil-api' })
    const at = '2024-05-01 12:00:00'
    await insertRows(db, 'users', [
      {
        uid: 1,
        ...OLD_SITE.owner,
        score: 1000,
        password: OLD_SITE_BCRYPT,
        ip: '127.0.0.1',
        permission: 2,
        last_sign_at: at,
        register_at: at,
        verified: 1,
      },
      {
        uid: 2,
        ...OLD_SITE.player,
        score: 200,
        password: OLD_SITE_BCRYPT,
        ip: '127.0.0.1',
        permission: 0,
        last_sign_at: at,
        register_at: at,
        verified: 1,
      },
    ])
    await insertRows(db, 'textures', [
      {
        tid: 1,
        name: 'Steve',
        type: 'steve',
        hash: pngs.steve.hash,
        size: 1,
        uploader: 1,
        public: 1,
        upload_at: at,
        likes: 1,
      },
      {
        tid: 2,
        name: 'Cape',
        type: 'cape',
        hash: pngs.narrowCape.hash,
        size: 1,
        uploader: 2,
        public: 1,
        upload_at: at,
        likes: 0,
      },
    ])
    await insertRows(db, 'players', [
      { pid: 1, uid: 1, name: 'Steve', tid_skin: 1, tid_cape: 0, last_modified: at },
      { pid: 2, uid: 2, name: 'Alex', tid_skin: -1, tid_cape: 2, last_modified: at },
    ])
    await insertRows(db, 'user_closet', [
      { user_uid: 1, texture_tid: 1, item_name: 'Steve' },
      { user_uid: 2, texture_tid: 2, item_name: 'Cape' },
    ])
    await insertRows(db, 'uuid', [
      { id: 1, name: 'Steve', uuid: OLD_SITE.steveUuid },
      { id: 2, name: 'Alex', uuid: OLD_SITE.alexUuids[0] },
      { id: 3, name: 'Alex', uuid: OLD_SITE.alexUuids[1] },
    ])
    await insertRows(db, 'options', [
      { option_name: 'site_name', option_value: 'Old Skin Site' },
      { option_name: 'version', option_value: '6.0.2' },
    ])
  } finally {
    await db.destroy()
  }

  const envFile = join(directory, '.env')
  await writeFile(
    envFile,
    [
      'APP_ENV=production',
      'DB_CONNECTION=sqlite',
      `DB_DATABASE=${file}`,
      'DB_PREFIX=',
      'PWD_METHOD=BCRYPT',
      'SALT=0123456789abcdef0123456789abcdef',
      'FS_DRIVER=local',
      `TEXTURES_DIR=${texturesDirectory}`,
      '',
    ].join('\n'),
  )
  return { file, texturesDirectory, envFile }
}
