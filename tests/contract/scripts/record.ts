// 从 BS v6 录制契约用例：pnpm --filter @nextskin/contract-tests record
// 先按 bs-v6/README.md 启动录制环境。脚本会清空 BS 里除超级管理员以外的用户、角色、材质和 UUID 映射，
// 写入 src/world.ts 描述的数据，再逐个发送 src/cases.ts 里的请求，结果写进 recordings/bs-v6.json。
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createConnection, type Connection } from 'mysql2/promise'
import { cases, DEFAULT_HEADERS } from '../src/cases.ts'
import type { RecordedResponse, Recording } from '../src/recording.ts'
import { sendCase, sendHttp } from '../src/replay.ts'
import { ORIGIN, orphanUuid, players, settings, textures, users } from '../src/world.ts'
import { assertSigningPublicKey, decodeTexturesValue, verifyPropertySignature } from '../src/yggdrasil.ts'

const compose = fileURLToPath(new URL('../bs-v6/compose.yaml', import.meta.url))
const fixtures = new URL('../fixtures/textures/', import.meta.url)
const output = new URL('../recordings/bs-v6.json', import.meta.url)
const target = new URL(ORIGIN)

// 与 bs-v6/Dockerfile、compose.yaml 一致
const SOURCE = {
  bs: '6.0.2',
  plugins: { 'yggdrasil-api': '5.2.1', 'usm-api': '1.2.3', 'legacy-api': '1.1.3' },
}

function app(...command: string[]): string {
  return execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', 'app', ...command], { encoding: 'utf8' })
}

/** BS 把 datetime 存成 config/app.php 里写死的 Asia/Shanghai（UTC+8，无夏令时）本地时间 */
function shanghai(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
}

const send = sendHttp(target)

async function setOption(db: Connection, name: string, value: string): Promise<void> {
  const [result] = await db.execute('update options set option_value = ? where option_name = ?', [value, name])
  if ((result as { affectedRows: number }).affectedRows === 0) {
    await db.execute('insert into options (option_name, option_value) values (?, ?)', [name, value])
  }
}

async function seed(db: Connection): Promise<void> {
  await db.beginTransaction()
  for (const table of ['user_closet', 'players', 'textures', 'uuid']) await db.query(`delete from ${table}`)
  await db.query('delete from users where uid <> 1')

  await setOption(db, 'site_url', settings.siteUrl)
  await setOption(db, 'site_name', settings.siteName)
  await setOption(db, 'cache_expire_time', String(settings.cacheMaxAge))
  await setOption(db, 'ygg_skin_domain', settings.skinDomains.join(','))
  await setOption(db, 'ygg_search_profile_max', String(settings.profileSearchLimit))
  await setOption(db, 'ygg_enable_ali', 'true')

  const permission = { banned: -1, user: 0, admin: 1, superadmin: 2 }
  for (const user of users) {
    if (user.uid === 1) continue
    await db.execute(
      `insert into users (uid, email, nickname, score, avatar, password, ip, permission, last_sign_at, register_at, verified)
       values (?, ?, ?, 0, 0, '', '127.0.0.1', ?, '2026-01-01 08:00:00', '2026-01-01 08:00:00', 1)`,
      [user.uid, user.email, user.nickname, permission[user.role]],
    )
  }
  for (const texture of textures) {
    await db.execute(
      `insert into textures (tid, name, type, hash, size, uploader, public, upload_at, likes)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        texture.tid,
        texture.name,
        texture.type,
        texture.file.hash,
        Math.ceil(texture.file.sizeBytes / 1024),
        texture.uploader,
        texture.isPublic ? 1 : 0,
        shanghai(texture.fileModifiedAt),
      ],
    )
  }
  for (const player of players) {
    await db.execute(
      'insert into players (pid, uid, name, tid_skin, tid_cape, last_modified) values (?, ?, ?, ?, ?, ?)',
      [player.pid, player.uid, player.name, player.bsSkin, player.bsCape, shanghai(player.updatedAt)],
    )
    if (player.bsUuidRow !== 'v3') {
      await db.execute('insert into uuid (name, uuid) values (?, ?)', [player.bsUuidRow.name, player.uuid])
    }
  }
  await db.execute('insert into uuid (name, uuid) values (?, ?)', [orphanUuid.name, orphanUuid.uuid])
  await db.commit()

  // 材质文件：BS 按 hash 存在 storage/textures 下，Last-Modified 取文件的修改时间
  app('sh', '-c', 'mkdir -p storage/textures && rm -f storage/textures/*')
  const copied = new Map<string, string>()
  for (const texture of textures) {
    if (!texture.stored) continue
    const previous = copied.get(texture.file.hash)
    if (previous !== undefined) {
      if (previous !== texture.fileModifiedAt) throw new Error(`同一个文件 ${texture.file.file} 的修改时间不一致`)
      continue
    }
    const path = `storage/textures/${texture.file.hash}`
    const source = fileURLToPath(new URL(texture.file.file, fixtures))
    execFileSync('docker', ['compose', '-f', compose, 'cp', source, `app:/app/${path}`], { stdio: 'pipe' })
    app('touch', '-d', `@${Date.parse(texture.fileModifiedAt) / 1000}`, path)
    copied.set(texture.file.hash, texture.fileModifiedAt)
  }
  app('chown', '-R', 'www-data:www-data', 'storage/textures')
  app('su', '-s', '/bin/sh', 'www-data', '-c', 'php artisan cache:clear')
}

/** yggdrasil-api 在角色第一次被 Yggdrasil 查询时才分配 UUID。先查一遍，再核对分配结果。 */
async function allocateUuids(db: Connection): Promise<void> {
  for (const player of players) {
    if (player.bsUuidRow !== 'v3') continue
    const path = `/api/yggdrasil/api/users/profiles/minecraft/${encodeURIComponent(player.name)}`
    const response = await send({ method: 'GET', path, headers: DEFAULT_HEADERS, body: '' })
    if (response.status !== 200) throw new Error(`预先分配 ${player.name} 的 UUID 失败：HTTP ${response.status}`)
  }
  const [rows] = await db.query('select name, uuid from uuid')
  const mapping = rows as { name: string; uuid: string }[]
  for (const player of players) {
    const expected = player.bsUuidRow === 'v3' ? player.name : player.bsUuidRow.name
    const row = mapping.find((item) => item.name === expected)
    if (row?.uuid !== player.uuid) {
      throw new Error(`${player.name} 在 BS 里的 UUID 是 ${row?.uuid}，world.ts 里是 ${player.uuid}`)
    }
  }
}

function checkYggdrasil(id: string, response: RecordedResponse, publicKey: string): void {
  if (response.body.kind !== 'json') return
  const body = response.body.value as { properties?: { name: string; value: string; signature?: string }[] }
  for (const property of body.properties ?? []) {
    if (property.signature !== undefined && !verifyPropertySignature(property.value, property.signature, publicKey)) {
      throw new Error(`${id}：BS 的签名用它自己的公钥验证不通过`)
    }
    if (property.name === 'textures') decodeTexturesValue(property.value)
  }
}

const db = await createConnection({
  host: '127.0.0.1',
  port: 38306,
  user: 'blessingskin',
  password: 'blessingskin',
  database: 'blessingskin',
  charset: 'utf8mb4',
})
try {
  await seed(db)
  await allocateUuids(db)
} finally {
  await db.end()
}

const meta = await send({ method: 'GET', path: '/api/yggdrasil', headers: DEFAULT_HEADERS, body: '' })
if (meta.body.kind !== 'json') throw new Error('BS 的 /api/yggdrasil 没有返回 JSON')
const publicKey = assertSigningPublicKey((meta.body.value as { signaturePublickey?: unknown }).signaturePublickey)

const recording: Recording = { source: { ...SOURCE, recordedAt: new Date().toISOString() }, cases: {} }
for (const contractCase of cases) {
  const response = await sendCase(send, contractCase)
  if (contractCase.body === 'yggdrasil-profile') checkYggdrasil(contractCase.id, response, publicKey)
  recording.cases[contractCase.id] = response
  console.log(`${String(response.status).padEnd(4)} ${contractCase.id}`)
}
writeFileSync(output, JSON.stringify(recording, null, 2) + '\n')
console.log(`已写入 ${fileURLToPath(output)}，共 ${cases.length} 个用例`)
