// 契约用例的固定数据。录制时写进 BS v6（scripts/record.ts），回放时写进 NextSkin（src/seed.ts），两边的数据必须等价。
// 改了这里就要重新录制。
import { createHash } from 'node:crypto'
import manifest from '../fixtures/textures/manifest.json' with { type: 'json' }

/** 录制环境的站点地址，也是 BS 的 site_url。请求都带这个 Host。 */
export const ORIGIN = 'http://127.0.0.1:38080'
export const HOST = '127.0.0.1:38080'

export type FixtureFile = (typeof manifest)[number]

function file(name: string): FixtureFile {
  const entry = manifest.find((item) => item.file === name)
  if (!entry) throw new Error(`fixtures/textures/manifest.json 里没有 ${name}；请运行 scripts/make-textures.ts`)
  return entry
}

export interface WorldUser {
  uid: number
  email: string
  nickname: string
  role: 'banned' | 'user' | 'admin' | 'superadmin'
}

export interface WorldTexture {
  tid: number
  name: string
  type: 'steve' | 'alex' | 'cape'
  file: FixtureFile
  /**
   * 存储里是否有这个文件。false 模拟"导入之后存储里丢了文件"：两边的数据库都有记录、存储里没有。
   * 这不是导入旧站里本来就缺文件的材质：那种材质导入器会跳过、把引用置空（docs/schema.md），由导入器的测试负责
   */
  stored: boolean
  uploader: number
  isPublic: boolean
  /** 文件的修改时间，即 `/textures/{hash}` 的 Last-Modified。整秒 */
  fileModifiedAt: string
}

export interface WorldPlayer {
  pid: number
  uid: number
  name: string
  uuid: string
  /** BS 里 tid_skin、tid_cape 的原始值；指向不存在的材质时，NextSkin 里是 null（导入规则） */
  bsSkin: number
  bsCape: number
  /** 整秒。CSL 的 Last-Modified、USM 的 last_update 都取自这里 */
  updatedAt: string
  /**
   * BS 的 uuid 表里这个角色的映射行：
   * - `v3`：不预先插入，录制前查询一次，让 yggdrasil-api 按离线算法分配，录制脚本核对分配结果等于 `uuid`；
   * - 字符串：预先插入一行，`name` 列是这个字符串（可以与角色名大小写不同，模拟改名或导入）。
   */
  bsUuidRow: 'v3' | { name: string }
}

/** 与 yggdrasil-api 的 generateUuidV3 相同：md5("OfflinePlayer:" + name)，再改写版本位和变体位 */
export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  bytes[6] = (bytes[6]! & 0x0f) | 0x30
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return bytes.toString('hex')
}

const steve = file('steve-64x64.png')
const alex = file('alex-64x64.png')
const legacy = file('legacy-64x32.png')
const hd = file('hd-128x128.png')
const cape = file('cape-64x32.png')
const ghost = file('ghost-64x64.png')

export const users: WorldUser[] = [
  // uid 1 是 BS 安装时创建的超级管理员，录制脚本不动它
  { uid: 1, email: 'admin@nextskin.test', nickname: 'admin', role: 'superadmin' },
  { uid: 2, email: 'steve@nextskin.test', nickname: 'steve', role: 'user' },
  { uid: 3, email: 'banned@nextskin.test', nickname: 'banned', role: 'banned' },
  { uid: 4, email: 'carol@nextskin.test', nickname: 'carol', role: 'admin' },
]

export const textures: WorldTexture[] = [
  {
    tid: 1,
    name: 'Steve',
    type: 'steve',
    file: steve,
    stored: true,
    uploader: 2,
    isPublic: true,
    fileModifiedAt: '2026-01-02T03:04:05.000Z',
  },
  {
    tid: 2,
    name: 'Alex',
    type: 'alex',
    file: alex,
    stored: true,
    uploader: 2,
    isPublic: true,
    fileModifiedAt: '2026-01-03T03:04:05.000Z',
  },
  {
    tid: 3,
    name: 'Legacy',
    type: 'steve',
    file: legacy,
    stored: true,
    uploader: 2,
    isPublic: false,
    fileModifiedAt: '2026-01-04T03:04:05.000Z',
  },
  {
    tid: 4,
    name: 'HD',
    type: 'alex',
    file: hd,
    stored: true,
    uploader: 4,
    isPublic: true,
    fileModifiedAt: '2026-01-05T03:04:05.000Z',
  },
  {
    tid: 5,
    name: 'Cape',
    type: 'cape',
    file: cape,
    stored: true,
    uploader: 2,
    isPublic: true,
    fileModifiedAt: '2026-01-06T03:04:05.000Z',
  },
  {
    tid: 6,
    name: 'Ghost',
    type: 'steve',
    file: ghost,
    stored: false,
    uploader: 2,
    isPublic: true,
    fileModifiedAt: '2026-01-07T03:04:05.000Z',
  },
  // 与 tid 1 同一个文件的另一个条目（BS 允许不同用户各存一份私有副本），文件只有一份
  {
    tid: 7,
    name: 'Steve copy',
    type: 'steve',
    file: steve,
    stored: true,
    uploader: 4,
    isPublic: false,
    fileModifiedAt: '2026-01-02T03:04:05.000Z',
  },
]

/** 被 uuid 表引用、但角色已经删除的映射行（BS 删除角色后会留下） */
export const orphanUuid = { name: 'DeletedPlayer', uuid: '5f0c1c9e0b3a4d6c9a7e2f1b3c4d5e6f' }

export const players: WorldPlayer[] = [
  {
    pid: 1,
    uid: 2,
    name: 'Steve',
    uuid: offlineUuid('Steve'),
    bsSkin: 1,
    bsCape: 5,
    updatedAt: '2026-02-03T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 2,
    uid: 2,
    name: 'Alex_01',
    uuid: offlineUuid('Alex_01'),
    bsSkin: 2,
    bsCape: 0,
    updatedAt: '2026-02-04T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 3,
    uid: 2,
    name: 'OldSkin',
    uuid: offlineUuid('OldSkin'),
    bsSkin: 3,
    bsCape: 0,
    updatedAt: '2026-02-05T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 4,
    uid: 4,
    name: 'HDSkin',
    uuid: offlineUuid('HDSkin'),
    bsSkin: 4,
    bsCape: 5,
    updatedAt: '2026-02-06T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 5,
    uid: 2,
    name: 'CapeOnly',
    uuid: offlineUuid('CapeOnly'),
    bsSkin: 0,
    bsCape: 5,
    updatedAt: '2026-02-07T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  // BS 新建角色时 tid_skin 的默认值是 -1
  {
    pid: 6,
    uid: 2,
    name: 'NoTextures',
    uuid: offlineUuid('NoTextures'),
    bsSkin: -1,
    bsCape: 0,
    updatedAt: '2026-02-08T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 7,
    uid: 2,
    name: 'Ghost',
    uuid: offlineUuid('Ghost'),
    bsSkin: 6,
    bsCape: 0,
    updatedAt: '2026-02-09T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  // 材质已被删除，BS 没有外键，tid 还留着
  {
    pid: 8,
    uid: 2,
    name: 'Dangling',
    uuid: offlineUuid('Dangling'),
    bsSkin: 999,
    bsCape: 998,
    updatedAt: '2026-02-10T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 9,
    uid: 2,
    name: '角色',
    uuid: offlineUuid('角色'),
    bsSkin: 1,
    bsCape: 0,
    updatedAt: '2026-02-11T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  // 角色名规则设为自定义时可以出现点号；CSL、USM、Legacy 的路由不接受带点的角色名
  {
    pid: 10,
    uid: 2,
    name: 'Dot.Name',
    uuid: offlineUuid('Dot.Name'),
    bsSkin: 1,
    bsCape: 0,
    updatedAt: '2026-02-12T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  {
    pid: 11,
    uid: 3,
    name: 'Banned',
    uuid: offlineUuid('Banned'),
    bsSkin: 1,
    bsCape: 5,
    updatedAt: '2026-02-13T04:34:56.000Z',
    bsUuidRow: 'v3',
  },
  // 改过名（离线算法下 BS 会改 UUID；导入后保留表里的值），映射行的名字大小写与角色名不同
  {
    pid: 12,
    uid: 4,
    name: 'Renamed',
    uuid: '0f8d2c4b6a1e4f3d8c7b9a6e5d4c3b2a',
    bsSkin: 7,
    bsCape: 0,
    updatedAt: '2026-02-14T04:34:56.000Z',
    bsUuidRow: { name: 'renamed' },
  },
  // 随机算法分配的 UUID
  {
    pid: 13,
    uid: 4,
    name: 'RandomUuid',
    uuid: '7c1e9a3b5d2f4e6a8b0c1d2e3f4a5b6c',
    bsSkin: 2,
    bsCape: 5,
    updatedAt: '2026-02-15T04:34:56.000Z',
    bsUuidRow: { name: 'RandomUuid' },
  },
]

/**
 * 站点设置。用非默认值，证明 NextSkin 读的是设置而不是写死的常量。
 * 录制脚本把它们写进 BS 的 options 表，种子脚本写进 NextSkin 的 settings 表。
 */
export const settings = {
  siteUrl: ORIGIN,
  siteName: 'NextSkin 契约测试站',
  /** BS 的 cache_expire_time */
  cacheMaxAge: 86400,
  /** BS 的 ygg_skin_domain（逗号分隔）。127.0.0.1 与 site_url 的主机重复，用来验证去重 */
  skinDomains: ['cdn.example.test', '127.0.0.1'],
  /** BS 的 ygg_search_profile_max */
  profileSearchLimit: 3,
}

export function playerByName(name: string): WorldPlayer {
  const player = players.find((item) => item.name === name)
  if (!player) throw new Error(`world.ts 里没有角色 ${name}`)
  return player
}

export function textureById(tid: number): WorldTexture | undefined {
  return textures.find((item) => item.tid === tid)
}
