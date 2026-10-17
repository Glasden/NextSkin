// 协议契约用例：只写请求和比对方式。响应从 BS v6 录制（scripts/record.ts），存在 recordings/bs-v6.json。
// 新增或修改用例后要重新录制。比对规则见 README.md 和 compare.ts。
import { HOST, offlineUuid, orphanUuid, playerByName, textures } from './world.ts'

export interface ContractRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS'
  /** 原样发送，不再编码：需要百分号编码的字符要在这里写好 */
  path: string
  headers?: Record<string, string>
  body?: string
}

/**
 * JSON 响应体的比对方式，默认 `exact`（深比较）：
 * - `yggdrasil-meta`：`implementationName`、`implementationVersion` 只要求是非空字符串，公钥只要求是 4096 位以上的 RSA 公钥；
 * - `yggdrasil-profile`：`textures` 属性解码后比较，其中 `timestamp` 只要求是录制或回放期间的时间；签名用各自的公钥验证；
 * - `yggdrasil-error`：`errorMessage` 只要求是非空字符串（提示文案由各自的语言包决定）。
 */
export type BodyMatch = 'exact' | 'yggdrasil-meta' | 'yggdrasil-profile' | 'yggdrasil-error'

export interface ContractCase {
  id: string
  title: string
  request: ContractRequest
  body?: BodyMatch
  /**
   * NextSkin 有意与 BS 不同的用例：照样录制 BS 的响应留档，但改为与 `compareWith` 指定的用例的录制结果比较。
   * 每一条都要列进 README.md 的"有意的差异"。
   */
  deviation?: { reason: string; compareWith: string }
}

/**
 * 每个请求默认带的头。Accept 用 Java HttpURLConnection 的默认值：CustomSkinLoader、authlib 都不改它，
 * BS 据此渲染 HTML 错误页（请求 JSON 时错误页的 Cache-Control 不同，见 README.md）。
 */
export const DEFAULT_HEADERS: Record<string, string> = {
  host: HOST,
  accept: 'text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2',
  'user-agent': 'Java/21.0.4',
}

function get(path: string, headers?: Record<string, string>): ContractRequest {
  return { method: 'GET', path, headers }
}

function method(name: ContractRequest['method'], path: string): ContractRequest {
  return { method: name, path }
}

function postJson(path: string, body: string, headers?: Record<string, string>): ContractRequest {
  return { method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body }
}

const hash = (tid: number) => textures.find((texture) => texture.tid === tid)!.file.hash
const uuidOf = (name: string) => playerByName(name).uuid
const STEVE_HASH = hash(1)
const CAPE_HASH = hash(5)
const GHOST_HASH = hash(6)

const csl: ContractCase[] = [
  { id: 'csl/root', title: 'CSL 根路径：有皮肤和披风', request: get('/Steve.json') },
  { id: 'csl/prefixed', title: 'CSL /csl 前缀', request: get('/csl/Steve.json') },
  { id: 'csl/lowercase', title: '角色名大小写不同', request: get('/csl/steve.json') },
  { id: 'csl/uppercase-root', title: '根路径，角色名全大写', request: get('/STEVE.json') },
  {
    id: 'csl/trailing-space',
    title: '角色名末尾有空格（MySQL 比较时忽略末尾空格）',
    request: get('/csl/Steve%20.json'),
  },
  { id: 'csl/leading-space', title: '角色名开头有空格', request: get('/csl/%20Steve.json') },
  { id: 'csl/alex', title: 'Alex 模型的皮肤', request: get('/csl/Alex_01.json') },
  { id: 'csl/legacy-skin', title: '64×32 旧格式皮肤', request: get('/csl/OldSkin.json') },
  { id: 'csl/hd', title: '高清皮肤', request: get('/csl/HDSkin.json') },
  { id: 'csl/cape-only', title: '只有披风', request: get('/csl/CapeOnly.json') },
  { id: 'csl/no-textures', title: '没有材质', request: get('/csl/NoTextures.json') },
  { id: 'csl/ghost', title: '材质文件丢失：仍然返回 hash', request: get('/csl/Ghost.json') },
  { id: 'csl/dangling', title: '材质条目已删除', request: get('/csl/Dangling.json') },
  { id: 'csl/shared-file', title: '两个材质条目指向同一个文件', request: get('/csl/Renamed.json') },
  { id: 'csl/cjk', title: '中文角色名', request: get('/csl/%E8%A7%92%E8%89%B2.json') },
  { id: 'csl/dot-name', title: '带点号的角色名：路由不匹配', request: get('/csl/Dot.Name.json') },
  { id: 'csl/dot-name-root', title: '根路径带点号的角色名', request: get('/Dot.Name.json') },
  { id: 'csl/empty-name', title: '空角色名', request: get('/csl/.json') },
  { id: 'csl/banned', title: '角色属于被封禁的用户', request: get('/csl/Banned.json') },
  { id: 'csl/missing', title: '角色不存在', request: get('/csl/Nobody.json') },
  { id: 'csl/missing-root', title: '根路径，角色不存在', request: get('/Nobody.json') },
  {
    id: 'csl/if-modified-since-equal',
    title: 'If-Modified-Since 等于 Last-Modified',
    request: get('/csl/Steve.json', { 'if-modified-since': 'Tue, 03 Feb 2026 04:34:56 GMT' }),
  },
  {
    id: 'csl/if-modified-since-later',
    title: 'If-Modified-Since 晚于 Last-Modified',
    request: get('/csl/Steve.json', { 'if-modified-since': 'Wed, 04 Feb 2026 00:00:00 GMT' }),
  },
  {
    id: 'csl/if-modified-since-earlier',
    title: 'If-Modified-Since 早于 Last-Modified',
    request: get('/csl/Steve.json', { 'if-modified-since': 'Tue, 03 Feb 2026 04:34:55 GMT' }),
  },
  {
    id: 'csl/if-modified-since-invalid',
    title: 'If-Modified-Since 无法解析',
    request: get('/csl/Steve.json', { 'if-modified-since': 'not a date' }),
  },
  {
    id: 'csl/if-none-match-star',
    title: 'If-None-Match: *（响应没有 ETag，不生效）',
    request: get('/csl/Steve.json', { 'if-none-match': '*' }),
  },
  {
    id: 'csl/if-none-match-and-modified-since',
    title: '响应没有 ETag 时，带 If-None-Match 也按 If-Modified-Since 判断',
    request: get('/csl/Steve.json', { 'if-none-match': '"abc"', 'if-modified-since': 'Tue, 03 Feb 2026 04:34:56 GMT' }),
  },
  {
    id: 'csl/if-modified-since-rfc850',
    title: 'If-Modified-Since 用 RFC 850 格式',
    request: get('/csl/Steve.json', { 'if-modified-since': 'Tuesday, 03-Feb-26 04:34:56 GMT' }),
  },
  {
    id: 'csl/if-modified-since-asctime',
    title: 'If-Modified-Since 用 asctime 格式（BS 按 Asia/Shanghai 解析，晚了 8 小时）',
    request: get('/csl/Steve.json', { 'if-modified-since': 'Tue Feb  3 04:34:56 2026' }),
  },
  {
    id: 'csl/if-modified-since-missing-player',
    title: '角色不存在时带 If-Modified-Since',
    request: get('/csl/Nobody.json', { 'if-modified-since': 'Tue, 03 Feb 2026 04:34:56 GMT' }),
  },
]

const usm: ContractCase[] = [
  { id: 'usm/steve', title: 'USM：有皮肤和披风', request: get('/usm/Steve.json') },
  { id: 'usm/uppercase', title: '角色名大小写不同', request: get('/usm/STEVE.json') },
  { id: 'usm/trailing-space', title: '角色名末尾有空格', request: get('/usm/Steve%20.json') },
  { id: 'usm/alex', title: 'Alex 模型的皮肤', request: get('/usm/Alex_01.json') },
  { id: 'usm/cape-only', title: '只有披风', request: get('/usm/CapeOnly.json') },
  { id: 'usm/no-textures', title: '没有材质', request: get('/usm/NoTextures.json') },
  { id: 'usm/dangling', title: '材质条目已删除', request: get('/usm/Dangling.json') },
  { id: 'usm/cjk', title: '中文角色名', request: get('/usm/%E8%A7%92%E8%89%B2.json') },
  { id: 'usm/dot-name', title: '带点号的角色名：路由不匹配', request: get('/usm/Dot.Name.json') },
  { id: 'usm/banned', title: '角色属于被封禁的用户', request: get('/usm/Banned.json') },
  { id: 'usm/missing', title: '角色不存在', request: get('/usm/Nobody.json') },
  {
    id: 'usm/if-modified-since',
    title: 'USM 不处理条件请求',
    request: get('/usm/Steve.json', { 'if-modified-since': 'Wed, 04 Feb 2026 00:00:00 GMT' }),
  },
]

const legacy: ContractCase[] = [
  { id: 'legacy/skin', title: 'Legacy 皮肤', request: get('/skin/Steve.png') },
  { id: 'legacy/cape', title: 'Legacy 披风', request: get('/cape/Steve.png') },
  { id: 'legacy/lowercase', title: '角色名大小写不同', request: get('/skin/steve.png') },
  { id: 'legacy/trailing-space', title: '角色名末尾有空格', request: get('/skin/Steve%20.png') },
  { id: 'legacy/alex', title: 'Alex 模型的皮肤', request: get('/skin/Alex_01.png') },
  { id: 'legacy/hd', title: '高清皮肤', request: get('/skin/HDSkin.png') },
  { id: 'legacy/no-cape', title: '没有披风', request: get('/cape/Alex_01.png') },
  { id: 'legacy/cape-only-skin', title: '只有披风的角色请求皮肤', request: get('/skin/CapeOnly.png') },
  { id: 'legacy/no-textures', title: '没有材质', request: get('/skin/NoTextures.png') },
  { id: 'legacy/ghost', title: '材质文件丢失', request: get('/skin/Ghost.png') },
  { id: 'legacy/dangling', title: '材质条目已删除', request: get('/skin/Dangling.png') },
  { id: 'legacy/cjk', title: '中文角色名', request: get('/skin/%E8%A7%92%E8%89%B2.png') },
  { id: 'legacy/dot-name', title: '带点号的角色名：路由不匹配', request: get('/skin/Dot.Name.png') },
  { id: 'legacy/banned', title: '角色属于被封禁的用户', request: get('/skin/Banned.png') },
  { id: 'legacy/banned-cape', title: '被封禁用户的披风', request: get('/cape/Banned.png') },
  { id: 'legacy/missing', title: '角色不存在', request: get('/skin/Nobody.png') },
  {
    id: 'legacy/if-modified-since',
    title: 'Legacy 不处理条件请求',
    request: get('/skin/Steve.png', { 'if-modified-since': 'Wed, 04 Feb 2099 00:00:00 GMT' }),
  },
]

const texture: ContractCase[] = [
  { id: 'textures/skin', title: '材质文件', request: get(`/textures/${STEVE_HASH}`) },
  { id: 'textures/cape', title: '披风文件', request: get(`/textures/${CAPE_HASH}`) },
  { id: 'textures/hd', title: '高清皮肤文件', request: get(`/textures/${hash(4)}`) },
  { id: 'textures/csl-prefix', title: '/csl/textures 前缀', request: get(`/csl/textures/${hash(2)}`) },
  { id: 'textures/legacy', title: '64×32 旧格式皮肤文件', request: get(`/textures/${hash(3)}`) },
  {
    id: 'textures/usm-prefix',
    title: '/usm/textures 前缀',
    request: get(`/usm/textures/${hash(3)}`),
    deviation: {
      reason: 'usm-api 1.2.3 注册这个路由时没写控制器的命名空间，BS 返回 500；NextSkin 按 /textures/{hash} 处理',
      compareWith: 'textures/legacy',
    },
  },
  { id: 'textures/uppercase', title: 'hash 大小写不同', request: get(`/textures/${STEVE_HASH.toUpperCase()}`) },
  { id: 'textures/unknown', title: '不存在的 hash', request: get(`/textures/${'0'.repeat(64)}`) },
  { id: 'textures/malformed', title: '格式不对的 hash', request: get('/textures/not-a-hash') },
  { id: 'textures/ghost', title: '有记录、文件丢失', request: get(`/textures/${GHOST_HASH}`) },
  {
    id: 'textures/if-modified-since-equal',
    title: 'If-Modified-Since 等于 Last-Modified',
    request: get(`/textures/${STEVE_HASH}`, { 'if-modified-since': 'Fri, 02 Jan 2026 03:04:05 GMT' }),
  },
  {
    id: 'textures/if-modified-since-earlier',
    title: 'If-Modified-Since 早于 Last-Modified',
    request: get(`/textures/${STEVE_HASH}`, { 'if-modified-since': 'Fri, 02 Jan 2026 03:04:04 GMT' }),
  },
  {
    id: 'textures/if-none-match-star',
    title: 'If-None-Match: *',
    request: get(`/textures/${STEVE_HASH}`, { 'if-none-match': '*' }),
  },
  {
    id: 'textures/if-none-match-weak-star',
    title: 'If-None-Match: W/*（先去掉 W/ 再比较）',
    request: get(`/textures/${STEVE_HASH}`, { 'if-none-match': 'W/*' }),
  },
  {
    id: 'textures/if-none-match-other',
    title: 'If-None-Match 不匹配',
    request: get(`/textures/${STEVE_HASH}`, { 'if-none-match': '"0123456789abcdef0123456789abcdef"' }),
  },
  {
    id: 'textures/if-none-match-other-and-modified-since',
    title: 'If-None-Match 不匹配时忽略 If-Modified-Since',
    request: get(`/textures/${STEVE_HASH}`, {
      'if-none-match': '"0123456789abcdef0123456789abcdef"',
      'if-modified-since': 'Fri, 02 Jan 2026 03:04:05 GMT',
    }),
  },
  {
    id: 'textures/if-modified-since-missing',
    title: '不存在的 hash 带 If-Modified-Since',
    request: get(`/textures/${'0'.repeat(64)}`, { 'if-modified-since': 'Fri, 02 Jan 2026 03:04:05 GMT' }),
  },
]

// ETag 的值取决于文件字节，只在录制结果里出现。下面这些用例的 If-None-Match 由录制脚本和回放程序
// 在运行时填入：先请求一次拿到 ETag，再按 `etagFrom` 指定的形式发送（见 resolveRequest）。
export interface EtagCase extends ContractCase {
  etagFrom: { path: string; format: 'exact' | 'weak' | 'list' }
}

const textureEtag: EtagCase[] = [
  {
    id: 'textures/if-none-match-exact',
    title: 'If-None-Match 等于 ETag',
    request: get(`/textures/${STEVE_HASH}`),
    etagFrom: { path: `/textures/${STEVE_HASH}`, format: 'exact' },
  },
  {
    id: 'textures/if-none-match-weak',
    title: 'If-None-Match 是弱 ETag（弱比较）',
    request: get(`/textures/${STEVE_HASH}`),
    etagFrom: { path: `/textures/${STEVE_HASH}`, format: 'weak' },
  },
  {
    id: 'textures/if-none-match-list',
    title: 'If-None-Match 是列表，其中一个匹配',
    request: get(`/textures/${STEVE_HASH}`),
    etagFrom: { path: `/textures/${STEVE_HASH}`, format: 'list' },
  },
]

const PROFILE = '/api/yggdrasil/sessionserver/session/minecraft/profile'
const BULK = '/api/yggdrasil/api/profiles/minecraft'
const SINGLE = '/api/yggdrasil/api/users/profiles/minecraft'

const yggdrasil: ContractCase[] = [
  { id: 'ygg/meta', title: 'API 元数据', request: get('/api/yggdrasil'), body: 'yggdrasil-meta' },
  {
    id: 'ygg/meta-post',
    title: '元数据接受任何方法',
    request: { method: 'POST', path: '/api/yggdrasil' },
    body: 'yggdrasil-meta',
  },
  {
    id: 'ygg/meta-other-host',
    title: '用其他域名访问：skinDomains 和链接跟随请求的 Host',
    request: get('/api/yggdrasil', { host: 'skin.example.test' }),
    body: 'yggdrasil-meta',
  },
  {
    id: 'ygg/meta-forwarded-https',
    title: '反向代理传来 X-Forwarded-Proto: https',
    request: get('/api/yggdrasil', { 'x-forwarded-proto': 'https' }),
    body: 'yggdrasil-meta',
  },
  {
    id: 'ygg/meta-forwarded-https-port-80',
    title: 'X-Forwarded-Proto: https 且 Host 带 :80：按连接本身的 http 去掉默认端口',
    request: get('/api/yggdrasil', { host: 'skin.example.test:80', 'x-forwarded-proto': 'https' }),
    body: 'yggdrasil-meta',
  },
  {
    id: 'ygg/meta-forwarded-proto-list',
    title: 'X-Forwarded-Proto 是列表时不算 https（BS 逐字比较）',
    request: get('/api/yggdrasil', { 'x-forwarded-proto': 'https,http' }),
    body: 'yggdrasil-meta',
  },
  {
    id: 'ygg/meta-forwarded-ssl',
    title: 'X-Forwarded-Ssl: on',
    request: get('/api/yggdrasil', { 'x-forwarded-ssl': 'on' }),
    body: 'yggdrasil-meta',
  },
  {
    id: 'ygg/meta-host-port',
    title: 'Host 带非默认端口和大写：链接保留端口，skinDomains 不带端口',
    request: get('/api/yggdrasil', { host: 'Skin.Example.Test:8443' }),
    body: 'yggdrasil-meta',
  },

  {
    id: 'ygg/profile',
    title: '按 UUID 查角色，不签名',
    request: get(`${PROFILE}/${uuidOf('Steve')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-signed',
    title: 'unsigned=false 时签名',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=false`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-true',
    title: 'unsigned=true',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=true`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-zero',
    title: 'unsigned=0：只有 true 和缺省才不签名',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=0`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-empty',
    title: 'unsigned 为空：视为缺省',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-repeated',
    title: 'unsigned 出现两次：PHP 取最后一个（false，签名）',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=true&unsigned=false`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-repeated-reverse',
    title: 'unsigned 出现两次：PHP 取最后一个（true，不签名）',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=false&unsigned=true`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-array',
    title: 'unsigned[]=true 是数组，不等于 true，签名',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned[]=true`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-padded-true',
    title: 'unsigned 的值先 trim：" true" 不签名',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=%20true`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-blank',
    title: 'unsigned 只有空格：trim 后为空，视为缺省',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=%20`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-unsigned-uppercase',
    title: 'unsigned=FALSE',
    request: get(`${PROFILE}/${uuidOf('Steve')}?unsigned=FALSE`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-alex',
    title: 'Alex 模型：带 metadata',
    request: get(`${PROFILE}/${uuidOf('Alex_01')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-alex-signed',
    title: 'Alex 模型，签名',
    request: get(`${PROFILE}/${uuidOf('Alex_01')}?unsigned=false`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-cape-only',
    title: '只有披风',
    request: get(`${PROFILE}/${uuidOf('CapeOnly')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-no-textures',
    title: '没有材质',
    request: get(`${PROFILE}/${uuidOf('NoTextures')}?unsigned=false`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-ghost',
    title: '材质文件丢失：仍然给出地址',
    request: get(`${PROFILE}/${uuidOf('Ghost')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-dangling',
    title: '材质条目已删除',
    request: get(`${PROFILE}/${uuidOf('Dangling')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-cjk',
    title: '中文角色名',
    request: get(`${PROFILE}/${uuidOf('角色')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-banned',
    title: '被封禁用户的角色仍然返回',
    request: get(`${PROFILE}/${uuidOf('Banned')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-renamed',
    title: '映射行的名字大小写与角色名不同',
    request: get(`${PROFILE}/${uuidOf('Renamed')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-random',
    title: '随机算法分配的 UUID',
    request: get(`${PROFILE}/${uuidOf('RandomUuid')}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-uppercase',
    title: 'UUID 大写',
    request: get(`${PROFILE}/${uuidOf('Steve').toUpperCase()}`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-trailing-space',
    title: 'UUID 末尾有空格（MySQL 比较时忽略末尾空格）',
    request: get(`${PROFILE}/${uuidOf('Steve')}%20`),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-hyphenated',
    title: '带连字符的 UUID 查不到',
    request: get(`${PROFILE}/${uuidOf('Steve').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}`),
  },
  {
    id: 'ygg/profile-encoded-slash',
    title: 'UUID 后面跟着编码的斜杠：Laravel 解码后路由不匹配',
    request: get(`${PROFILE}/${uuidOf('Steve')}%2F`),
  },
  { id: 'ygg/profile-unknown', title: '不存在的 UUID', request: get(`${PROFILE}/${'0'.repeat(32)}`) },
  { id: 'ygg/profile-orphan', title: '映射行的角色已删除', request: get(`${PROFILE}/${orphanUuid.uuid}`) },
  {
    id: 'ygg/profile-offline-unknown',
    title: '名字的离线 UUID，但角色不存在',
    request: get(`${PROFILE}/${offlineUuid('Nobody')}`),
  },
  {
    id: 'ygg/profile-other-host',
    title: '用其他域名访问：材质地址仍用站点地址',
    request: get(`${PROFILE}/${uuidOf('Steve')}`, { host: 'skin.example.test' }),
    body: 'yggdrasil-profile',
  },
  {
    id: 'ygg/profile-forwarded-https',
    title: 'X-Forwarded-Proto: https 时材质地址用 https',
    request: get(`${PROFILE}/${uuidOf('Steve')}`, { 'x-forwarded-proto': 'https' }),
    body: 'yggdrasil-profile',
  },

  {
    id: 'ygg/bulk',
    title: '按名字批量查询：返回请求里的名字，不是角色名',
    request: postJson(BULK, '["steve","Alex_01","Nobody"]'),
  },
  { id: 'ygg/bulk-empty', title: '空数组', request: postJson(BULK, '[]') },
  {
    id: 'ygg/bulk-duplicates',
    title: '完全相同的名字去重，大小写不同的不去重',
    request: postJson(BULK, '["Steve","Steve","steve","Steve"]'),
  },
  { id: 'ygg/bulk-at-limit', title: '去重后恰好等于上限', request: postJson(BULK, '["Steve","Alex_01","HDSkin"]') },
  {
    id: 'ygg/bulk-over-limit',
    title: '去重后超过上限',
    request: postJson(BULK, '["Steve","Alex_01","HDSkin","CapeOnly"]'),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/bulk-over-limit-before-dedupe',
    title: '去重前超过上限、去重后不超过',
    request: postJson(BULK, '["Steve","Steve","Alex_01","Alex_01","HDSkin"]'),
  },
  {
    id: 'ygg/bulk-banned-and-special',
    title: '被封禁用户的角色、中文名、带点号的名字',
    request: postJson(BULK, '["Banned","角色","Dot.Name"]'),
  },
  { id: 'ygg/bulk-trailing-space', title: '名字末尾有空格', request: postJson(BULK, '["Steve "]') },
  { id: 'ygg/bulk-not-json', title: '请求体不是 JSON', request: postJson(BULK, 'Steve') },
  // BS 用 array_unique($request->json()->all())：所有元素都参与去重和计数，对象取值，单个值当作只有一个元素
  {
    id: 'ygg/bulk-null-counts',
    title: 'null 也计入上限',
    request: postJson(BULK, '["Steve","Alex_01","HDSkin",null]'),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/bulk-numbers-count',
    title: '数字也计入上限',
    request: postJson(BULK, '[1,2,3,4]'),
    body: 'yggdrasil-error',
  },
  { id: 'ygg/bulk-object', title: '请求体是对象：按值查询', request: postJson(BULK, '{"a":"Steve","b":"Alex_01"}') },
  { id: 'ygg/bulk-scalar', title: '请求体是单个字符串', request: postJson(BULK, '"Steve"') },
  // Laravel 的 TrimStrings 中间件对 JSON 请求体里的字符串做 trim()，ConvertEmptyStringsToNull 再把空串换成 null
  { id: 'ygg/bulk-leading-space', title: '名字开头有空格：先 trim 再查', request: postJson(BULK, '[" Steve"]') },
  {
    id: 'ygg/bulk-dedupe-after-trim',
    title: 'trim 之后再去重',
    request: postJson(BULK, '["Steve","Steve ","\\tSteve\\n"]'),
  },
  {
    id: 'ygg/bulk-limit-after-trim',
    title: 'trim、去重之后才检查上限',
    request: postJson(BULK, '["Nobody","Nobody ","Alex_01","HDSkin"]'),
  },
  { id: 'ygg/bulk-empty-string', title: '空串当作 null，查不到', request: postJson(BULK, '["","Steve"]') },
  {
    id: 'ygg/bulk-text-content-type',
    title: 'Content-Type 不是 JSON 时不 trim',
    request: postJson(BULK, '[" Steve"]', { 'content-type': 'text/plain' }),
  },

  { id: 'ygg/single', title: '按名字查单个角色：返回请求里的名字', request: get(`${SINGLE}/steve`) },
  { id: 'ygg/single-exact', title: '名字完全相同', request: get(`${SINGLE}/Alex_01`) },
  { id: 'ygg/single-dot-name', title: '带点号的名字（这个路由没有后缀）', request: get(`${SINGLE}/Dot.Name`) },
  { id: 'ygg/single-banned', title: '被封禁用户的角色', request: get(`${SINGLE}/Banned`) },
  { id: 'ygg/single-cjk', title: '中文角色名', request: get(`${SINGLE}/%E8%A7%92%E8%89%B2`) },
  { id: 'ygg/single-missing', title: '角色不存在', request: get(`${SINGLE}/Nobody`) },
  {
    id: 'ygg/single-encoded-slash',
    title: '名字后面跟着编码的斜杠：Laravel 解码后路由不匹配',
    request: get(`${SINGLE}/Steve%2F`),
  },
]

// 方法不对时 Laravel 返回 405 和 Allow；OPTIONS 由路由器直接回答
const methods: ContractCase[] = [
  { id: 'methods/csl-post', title: 'POST CSL', request: method('POST', '/csl/Steve.json') },
  { id: 'methods/csl-root-delete', title: 'DELETE 根路径 CSL', request: method('DELETE', '/Steve.json') },
  { id: 'methods/csl-options', title: 'OPTIONS CSL', request: method('OPTIONS', '/csl/Steve.json') },
  { id: 'methods/usm-delete', title: 'DELETE USM', request: method('DELETE', '/usm/Steve.json') },
  { id: 'methods/legacy-put', title: 'PUT Legacy', request: method('PUT', '/skin/Steve.png') },
  { id: 'methods/textures-post', title: 'POST 材质文件', request: method('POST', `/textures/${STEVE_HASH}`) },
  { id: 'methods/textures-options', title: 'OPTIONS 材质文件', request: method('OPTIONS', `/textures/${STEVE_HASH}`) },
  { id: 'methods/bulk-get', title: 'GET 批量查询', request: get(BULK) },
  { id: 'methods/bulk-options', title: 'OPTIONS 批量查询', request: method('OPTIONS', BULK) },
  { id: 'methods/profile-post', title: 'POST 按 UUID 查询', request: method('POST', `${PROFILE}/${uuidOf('Steve')}`) },
  { id: 'methods/single-delete', title: 'DELETE 按名字查询', request: method('DELETE', `${SINGLE}/Steve`) },
  {
    id: 'methods/meta-options',
    title: 'OPTIONS 元数据（Route::any 接受任何方法）',
    request: method('OPTIONS', '/api/yggdrasil'),
    body: 'yggdrasil-meta',
  },
]

// HEAD：Laravel 在缓存中间件之前就清空了响应体，成功的 CSL 和材质响应因此没有公开缓存头、ETag 和条件请求
const head: ContractCase[] = [
  { id: 'head/csl', title: 'HEAD CSL', request: method('HEAD', '/csl/Steve.json') },
  { id: 'head/csl-missing', title: 'HEAD CSL，角色不存在', request: method('HEAD', '/csl/Nobody.json') },
  {
    id: 'head/csl-if-modified-since',
    title: 'HEAD CSL 带 If-Modified-Since：不处理条件请求',
    request: {
      method: 'HEAD',
      path: '/csl/Steve.json',
      headers: { 'if-modified-since': 'Wed, 04 Feb 2026 00:00:00 GMT' },
    },
  },
  { id: 'head/usm', title: 'HEAD USM', request: method('HEAD', '/usm/Steve.json') },
  { id: 'head/legacy', title: 'HEAD Legacy', request: method('HEAD', '/skin/Steve.png') },
  { id: 'head/textures', title: 'HEAD 材质文件', request: method('HEAD', `/textures/${STEVE_HASH}`) },
  {
    id: 'head/textures-if-none-match',
    title: 'HEAD 材质文件带 If-None-Match: *',
    request: { method: 'HEAD', path: `/textures/${STEVE_HASH}`, headers: { 'if-none-match': '*' } },
  },
  {
    id: 'head/textures-missing',
    title: 'HEAD 不存在的材质文件',
    request: method('HEAD', `/textures/${'0'.repeat(64)}`),
  },
  { id: 'head/meta', title: 'HEAD 元数据', request: method('HEAD', '/api/yggdrasil') },
  { id: 'head/profile', title: 'HEAD 按 UUID 查询', request: method('HEAD', `${PROFILE}/${uuidOf('Steve')}`) },
]

export const cases: ContractCase[] = [
  ...csl,
  ...usm,
  ...legacy,
  ...texture,
  ...textureEtag,
  ...yggdrasil,
  ...methods,
  ...head,
]

export function isEtagCase(contractCase: ContractCase): contractCase is EtagCase {
  return 'etagFrom' in contractCase
}

/** 合并默认请求头；ETag 用例按第一次请求拿到的 ETag 填入 If-None-Match。 */
export function resolveRequest(contractCase: ContractCase, etag?: string): Required<ContractRequest> {
  const headers = { ...DEFAULT_HEADERS, ...contractCase.request.headers }
  if (isEtagCase(contractCase)) {
    if (!etag) throw new Error(`用例 ${contractCase.id} 需要先取得 ${contractCase.etagFrom.path} 的 ETag`)
    const bare = etag.replace(/^W\//, '')
    headers['if-none-match'] = {
      exact: etag,
      weak: `W/${bare}`,
      list: `"0123456789abcdef0123456789abcdef", ${bare}`,
    }[contractCase.etagFrom.format]
  }
  return {
    method: contractCase.request.method,
    path: contractCase.request.path,
    headers,
    body: contractCase.request.body ?? '',
  }
}

for (const [index, contractCase] of cases.entries()) {
  if (cases.findIndex((other) => other.id === contractCase.id) !== index)
    throw new Error(`用例 id 重复：${contractCase.id}`)
  const target = contractCase.deviation?.compareWith
  if (target !== undefined && !cases.some((other) => other.id === target && !other.deviation)) {
    throw new Error(`用例 ${contractCase.id} 的 compareWith 必须指向一个没有差异的用例：${target}`)
  }
}
