// 协议契约用例：只写请求和比对方式。响应从 BS v6 录制（scripts/record.ts），存在 recordings/bs-v6.json。
// 新增或修改用例后要重新录制。比对规则见 README.md 和 compare.ts。
import { readFileSync } from 'node:fs'
import { HOST, offlineUuid, orphanUuid, PASSWORD, playerByName, textures } from './world.ts'

export interface ContractRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS'
  /** 原样发送，不再编码：需要百分号编码的字符要在这里写好 */
  path: string
  headers?: Record<string, string>
  /** 字符串按 UTF-8 发送；上传材质的 multipart 请求体是字节 */
  body?: string | Uint8Array
}

/**
 * JSON 响应体的比对方式，默认 `exact`（深比较）：
 * - `yggdrasil-meta`：`implementationName`、`implementationVersion` 只要求是非空字符串，公钥只要求是 4096 位以上的 RSA 公钥；
 * - `yggdrasil-profile`：`textures` 属性解码后比较，其中 `timestamp` 只要求是录制或回放期间的时间；签名用各自的公钥验证；
 * - `yggdrasil-error`：`errorMessage` 只要求是非空字符串（提示文案由各自的语言包决定）；
 * - `yggdrasil-token`：只用于场景，见 `ScenarioStep`。`accessToken` 只要求是非空字符串，并且与这个场景里之前出现过的都不同；
 *   请求里给了 `clientToken` 时逐字比较；没给时第一次出现只要求非空，之后录制结果里同一个值在回放里也要相同；其余字段深比较。
 */
export type BodyMatch = 'exact' | 'yggdrasil-meta' | 'yggdrasil-profile' | 'yggdrasil-error' | 'yggdrasil-token'

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

const MULTIPART_BOUNDARY = '----NextSkinContractBoundary7MA4YWxkTrZu0gW'

/** 启动器上传材质的请求体：先是 model 字段，再是文件（HMCL 的顺序） */
function multipart(fixture: string, filename: string, model?: string): Uint8Array {
  const parts: Buffer[] = []
  if (model !== undefined)
    parts.push(
      Buffer.from(`--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`),
    )
  parts.push(
    Buffer.from(
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: image/png\r\n\r\n',
    ),
    readFileSync(new URL(`../fixtures/textures/${fixture}`, import.meta.url)),
    Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--\r\n`),
  )
  return new Uint8Array(Buffer.concat(parts))
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

const AUTHSERVER = '/api/yggdrasil/authserver'
const SESSIONSERVER = '/api/yggdrasil/sessionserver/session/minecraft'
const USER_PROFILE = '/api/yggdrasil/api/user/profile'
/** 不存在的令牌 */
const UNKNOWN_TOKEN = 'f'.repeat(32)

function authserver(endpoint: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  return postJson(`${AUTHSERVER}/${endpoint}`, JSON.stringify(body), headers)
}

// 不依赖令牌的 authserver、进服、上传请求。authenticate 和 signout 按 username 节流，只放在场景里（见下）。
const yggdrasilStateless: ContractCase[] = [
  {
    id: 'ygg/authenticate-not-json',
    title: 'authserver 只收 JSON：其他 Content-Type 返回 200 和错误',
    request: authserver(
      'authenticate',
      { username: 'steve@nextskin.test', password: PASSWORD },
      {
        'content-type': 'text/plain',
      },
    ),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/authenticate-form',
    title: '表单格式的 authenticate',
    request: {
      method: 'POST',
      path: `${AUTHSERVER}/authenticate`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=steve%40nextskin.test&password=${PASSWORD}`,
    },
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/authenticate-no-content-type',
    title: '没有 Content-Type',
    request: { method: 'POST', path: `${AUTHSERVER}/authenticate`, body: '{}' },
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/refresh-not-json',
    title: 'refresh 不是 JSON',
    request: authserver('refresh', { accessToken: UNKNOWN_TOKEN }, { 'content-type': 'text/plain' }),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/validate-not-json',
    title: 'validate 不是 JSON',
    request: authserver('validate', { accessToken: UNKNOWN_TOKEN }, { 'content-type': 'text/plain' }),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/invalidate-not-json',
    title: 'invalidate 不是 JSON',
    request: authserver('invalidate', { accessToken: UNKNOWN_TOKEN }, { 'content-type': 'text/plain' }),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/signout-not-json',
    title: 'signout 不是 JSON（在节流之前就返回）',
    request: authserver(
      'signout',
      { username: 'steve@nextskin.test', password: PASSWORD },
      {
        'content-type': 'text/plain',
      },
    ),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/refresh-unknown',
    title: 'refresh 不存在的令牌',
    request: authserver('refresh', { accessToken: UNKNOWN_TOKEN, clientToken: 'client' }),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/validate-unknown',
    title: 'validate 不存在的令牌',
    request: authserver('validate', { accessToken: UNKNOWN_TOKEN }),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/invalidate-unknown',
    title: 'invalidate 不存在的令牌也返回 204',
    request: authserver('invalidate', { accessToken: UNKNOWN_TOKEN, clientToken: 'client' }),
  },
  {
    id: 'ygg/join-unknown-token',
    title: 'join 不存在的令牌',
    request: postJson(
      `${SESSIONSERVER}/join`,
      JSON.stringify({ accessToken: UNKNOWN_TOKEN, selectedProfile: uuidOf('Steve'), serverId: 'contract-server' }),
    ),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/join-unknown-profile',
    title: 'join 不存在的角色',
    request: postJson(
      `${SESSIONSERVER}/join`,
      JSON.stringify({ accessToken: UNKNOWN_TOKEN, selectedProfile: '0'.repeat(32), serverId: 'contract-server' }),
    ),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/join-empty',
    title: 'join 的请求体是空对象',
    request: postJson(`${SESSIONSERVER}/join`, '{}'),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/has-joined-unknown',
    title: 'hasJoined：没有这个 serverId 的进服记录',
    request: get(`${SESSIONSERVER}/hasJoined?username=Steve&serverId=no-such-server`),
  },
  {
    id: 'ygg/has-joined-empty',
    title: 'hasJoined 没有参数',
    request: get(`${SESSIONSERVER}/hasJoined`),
  },
  {
    id: 'ygg/upload-no-token',
    title: '上传材质没有 Authorization',
    request: {
      method: 'PUT',
      path: `${USER_PROFILE}/${uuidOf('Steve')}/skin`,
      headers: { 'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}` },
      body: multipart('steve-64x64.png', 'steve.png'),
    },
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/upload-unknown-token',
    title: '上传材质，令牌不存在',
    request: {
      method: 'PUT',
      path: `${USER_PROFILE}/${uuidOf('Steve')}/skin`,
      headers: {
        authorization: `Bearer ${UNKNOWN_TOKEN}`,
        'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body: multipart('steve-64x64.png', 'steve.png'),
    },
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/upload-basic-auth',
    title: '上传材质用 Basic 认证',
    request: {
      method: 'PUT',
      path: `${USER_PROFILE}/${uuidOf('Steve')}/skin`,
      headers: {
        authorization: `Basic ${Buffer.from(`steve@nextskin.test:${PASSWORD}`).toString('base64')}`,
        'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      },
      body: multipart('steve-64x64.png', 'steve.png'),
    },
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/delete-no-token',
    title: '删除材质没有 Authorization',
    request: method('DELETE', `${USER_PROFILE}/${uuidOf('Steve')}/skin`),
    body: 'yggdrasil-error',
  },
  {
    id: 'ygg/delete-unknown-token',
    title: '删除材质，令牌不存在',
    request: {
      method: 'DELETE',
      path: `${USER_PROFILE}/${uuidOf('Steve')}/cape`,
      headers: { authorization: `Bearer ${UNKNOWN_TOKEN}` },
    },
    body: 'yggdrasil-error',
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
  { id: 'methods/authenticate-get', title: 'GET authenticate', request: get(`${AUTHSERVER}/authenticate`) },
  { id: 'methods/validate-options', title: 'OPTIONS validate', request: method('OPTIONS', `${AUTHSERVER}/validate`) },
  { id: 'methods/join-get', title: 'GET join', request: get(`${SESSIONSERVER}/join`) },
  { id: 'methods/has-joined-post', title: 'POST hasJoined', request: method('POST', `${SESSIONSERVER}/hasJoined`) },
  {
    id: 'methods/user-profile-post',
    title: 'POST 上传材质的路径',
    request: method('POST', `${USER_PROFILE}/${uuidOf('Steve')}/skin`),
  },
  {
    id: 'methods/user-profile-get',
    title: 'GET 上传材质的路径',
    request: get(`${USER_PROFILE}/${uuidOf('Steve')}/skin`),
  },
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
  ...yggdrasilStateless,
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

// ---------------------------------------------------------------------------------------------------------------
// 场景：authserver 和进服是有状态的，一个场景按顺序发几个请求，后面的请求用前面响应里的令牌（ADR-0030）。
// 每个场景开始前，录制时恢复固定数据、清空 BS 的缓存（令牌、节流、进服记录都在里面）；回放时用新的核心实例。
// authenticate 和 signout 按 username 节流（同一个 username 1 秒内只能请求一次），同一个场景里换着用邮箱和角色名。

/** 前面的步骤取到的值，键是 `capture` 里起的名字 */
export type Captured = Record<string, string>

export interface ScenarioStep {
  title: string
  request: ContractRequest | ((captured: Captured) => ContractRequest)
  body?: BodyMatch
  /** 从这一步的 JSON 响应里取值：{ 名字: 响应里的键 } */
  capture?: Record<string, 'accessToken' | 'clientToken'>
  /** 同 ContractCase 的 deviation：照样录制 BS 的响应，回放时改为与 `compareWith` 这个一问一答用例的录制结果比较 */
  deviation?: { reason: string; compareWith: string }
}

export interface ContractScenario {
  id: string
  title: string
  steps: ScenarioStep[]
}

const STEVE = 'steve@nextskin.test'
const DAVE = 'dave@nextskin.test'
const BANNED = 'banned@nextskin.test'

/** 登录并把令牌记作 `as` */
function login(username: string, as = 'token', extra: Record<string, unknown> = {}): ScenarioStep {
  return {
    title: `用 ${username} 登录`,
    request: authserver('authenticate', { username, password: PASSWORD, ...extra }),
    body: 'yggdrasil-token',
    capture: { [as]: 'accessToken' },
  }
}

function rejected(title: string, request: ScenarioStep['request']): ScenarioStep {
  return { title, request, body: 'yggdrasil-error' }
}

function validate(as = 'token', extra: Record<string, unknown> = {}): ScenarioStep {
  return {
    title: `validate ${as}`,
    request: (captured) => authserver('validate', { accessToken: captured[as], ...extra }),
    body: 'yggdrasil-error',
  }
}

function join(profile: string, as = 'token', serverId = 'server-1', headers?: Record<string, string>) {
  return (captured: Captured) =>
    postJson(
      `${SESSIONSERVER}/join`,
      JSON.stringify({ accessToken: captured[as], selectedProfile: profile, serverId }),
      headers,
    )
}

function hasJoined(query: string): ScenarioStep {
  return { title: `hasJoined?${query}`, request: get(`${SESSIONSERVER}/hasJoined?${query}`), body: 'yggdrasil-profile' }
}

function upload(profile: string, type: string, fixture: string, filename: string, model?: string, as = 'token') {
  return (captured: Captured): ContractRequest => ({
    method: 'PUT',
    path: `${USER_PROFILE}/${profile}/${type}`,
    headers: {
      authorization: `Bearer ${captured[as]}`,
      'content-type': `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
    },
    body: multipart(fixture, filename, model),
  })
}

function reset(profile: string, type: string, as = 'token') {
  return (captured: Captured): ContractRequest => ({
    method: 'DELETE',
    path: `${USER_PROFILE}/${profile}/${type}`,
    headers: { authorization: `Bearer ${captured[as]}` },
  })
}

const SECURITY_DEVIATION = 'yggdrasil-api 的安全缺陷（ADR-0030）'

const authenticateScenarios: ContractScenario[] = [
  {
    id: 'auth/authenticate-email',
    title: '用邮箱登录：多个角色时不自动绑定，clientToken 原样返回，requestUser 返回用户 ID',
    steps: [
      login(STEVE, 'token', {
        clientToken: 'launcher-client-1',
        requestUser: true,
        agent: { name: 'Minecraft', version: 1 },
      }),
    ],
  },
  {
    id: 'auth/authenticate-single-profile',
    title: '只有一个角色时自动绑定；没给 clientToken 时由服务端生成',
    steps: [login(DAVE)],
  },
  {
    id: 'auth/authenticate-player-name',
    title: '用角色名登录，大小写不同也能找到',
    steps: [login('alex_01', 'token', { requestUser: true })],
  },
  {
    id: 'auth/authenticate-email-case',
    title: '邮箱大小写不同也能找到，用户 ID 按库里的邮箱算',
    steps: [login('Steve@NextSkin.Test', 'token', { requestUser: true })],
  },
  {
    id: 'auth/authenticate-trimmed',
    title: '用户名和密码首尾的空白被 trim（BS 的 TrimStrings）',
    steps: [
      {
        title: '用户名和密码首尾带空格',
        request: authserver('authenticate', { username: ` ${DAVE} `, password: ` ${PASSWORD}\t` }),
        body: 'yggdrasil-token',
      },
    ],
  },
  {
    id: 'auth/authenticate-request-user',
    title: 'requestUser 按 PHP 的真假判断',
    steps: [
      login(STEVE, 'a', { requestUser: 'false' }),
      login('Dave', 'b', { requestUser: '0' }),
      login('Alex_01', 'c', { requestUser: 1 }),
      login(DAVE, 'd', { requestUser: false }),
    ],
  },
  {
    id: 'auth/authenticate-content-type',
    title: 'Content-Type 带参数或是 text/json 时也算 JSON',
    steps: [
      {
        title: 'application/json; charset=UTF-8',
        request: authserver(
          'authenticate',
          { username: DAVE, password: PASSWORD },
          {
            'content-type': 'application/json; charset=UTF-8',
          },
        ),
        body: 'yggdrasil-token',
      },
      {
        title: 'text/json',
        request: authserver('authenticate', { username: STEVE, password: PASSWORD }, { 'content-type': 'text/json' }),
        body: 'yggdrasil-token',
      },
    ],
  },
  {
    id: 'auth/authenticate-rejected',
    title: '密码错误、用户不存在、角色不存在都是 403',
    steps: [
      rejected('密码错误', authserver('authenticate', { username: STEVE, password: 'wrong-password' })),
      rejected('邮箱不存在', authserver('authenticate', { username: 'nobody@nextskin.test', password: PASSWORD })),
      rejected('角色不存在', authserver('authenticate', { username: 'Nobody', password: PASSWORD })),
      rejected('用角色名登录，密码错误', authserver('authenticate', { username: 'Dave', password: 'wrong' })),
    ],
  },
  {
    id: 'auth/authenticate-missing',
    title: '用户名或密码为空返回 400',
    steps: [
      rejected('没有密码', authserver('authenticate', { username: STEVE })),
      rejected('没有用户名', authserver('authenticate', { password: PASSWORD })),
      rejected('密码是空串（ConvertEmptyStringsToNull）', authserver('authenticate', { username: DAVE, password: '' })),
    ],
  },
  {
    id: 'auth/authenticate-banned',
    title: '被封禁的用户密码正确也不能登录',
    steps: [rejected('被封禁的用户', authserver('authenticate', { username: BANNED, password: PASSWORD }))],
  },
  {
    id: 'auth/authenticate-throttled',
    title: '同一个 username 1 秒内只能请求一次，不论成败；换个 username 不受影响',
    steps: [
      login(STEVE, 'a'),
      rejected('同一个邮箱马上再登录', authserver('authenticate', { username: STEVE, password: PASSWORD })),
      rejected('另一个用户密码错误', authserver('authenticate', { username: DAVE, password: 'wrong' })),
      rejected('马上用正确的密码重试', authserver('authenticate', { username: DAVE, password: PASSWORD })),
      login('Steve', 'b'),
      validate('a'),
      validate('b'),
    ],
  },
  {
    id: 'auth/tokens-limit',
    title: '每个用户的令牌数有上限（ygg_tokens_limit = 3），挤掉最早的',
    steps: [
      login('Steve', 'a'),
      login('Alex_01', 'b'),
      login('OldSkin', 'c'),
      login(STEVE, 'd'),
      validate('a'),
      validate('b'),
      validate('d'),
    ],
  },
]

const refreshScenarios: ContractScenario[] = [
  {
    id: 'auth/refresh',
    title: 'refresh 签发新令牌、沿用 clientToken 和绑定的角色，旧令牌失效',
    steps: [
      login(DAVE, 'old', { clientToken: 'client-dave' }),
      {
        title: 'refresh',
        request: (captured) =>
          authserver('refresh', { accessToken: captured.old, clientToken: 'client-dave', requestUser: true }),
        body: 'yggdrasil-token',
        capture: { new: 'accessToken' },
      },
      validate('old'),
      validate('new', { clientToken: 'client-dave' }),
      rejected('再用旧令牌 refresh', (captured) => authserver('refresh', { accessToken: captured.old })),
    ],
  },
  {
    id: 'auth/refresh-without-client-token',
    title: 'refresh 不带 clientToken',
    steps: [
      login(STEVE, 'old', { clientToken: 'client-steve' }),
      {
        title: 'refresh',
        request: (captured) => authserver('refresh', { accessToken: captured.old }),
        body: 'yggdrasil-token',
        capture: { new: 'accessToken' },
      },
      validate('new'),
    ],
  },
  {
    id: 'auth/refresh-wrong-client-token',
    title: 'refresh 的 clientToken 不一致：403，旧令牌仍然有效',
    steps: [
      login(STEVE, 'token', { clientToken: 'client-steve' }),
      rejected('clientToken 不一致', (captured) =>
        authserver('refresh', { accessToken: captured.token, clientToken: 'other-client' }),
      ),
      validate('token'),
    ],
  },
  {
    id: 'auth/refresh-select-profile',
    title: 'refresh 时选择角色，之后能用它进服',
    steps: [
      login(STEVE, 'old'),
      {
        title: '选择 Alex_01',
        request: (captured) =>
          authserver('refresh', {
            accessToken: captured.old,
            selectedProfile: { id: uuidOf('Alex_01'), name: 'Alex_01' },
          }),
        body: 'yggdrasil-token',
        capture: { new: 'accessToken' },
      },
      { title: '用 Alex_01 进服', request: join(uuidOf('Alex_01'), 'new') },
      hasJoined('username=Alex_01&serverId=server-1'),
    ],
  },
  {
    id: 'auth/refresh-select-by-id',
    title: '选择角色按 id 找，名字只要求有角色叫这个名字',
    steps: [
      login(STEVE, 'old'),
      {
        title: 'id 是 OldSkin，名字是 Steve',
        request: (captured) =>
          authserver('refresh', {
            accessToken: captured.old,
            selectedProfile: { id: uuidOf('OldSkin'), name: 'Steve' },
          }),
        body: 'yggdrasil-token',
      },
    ],
  },
  {
    id: 'auth/refresh-select-rejected',
    title: '选择角色：名字不存在 400，不是自己的角色 403，旧令牌仍然有效',
    steps: [
      login(STEVE, 'token'),
      rejected('没有叫这个名字的角色', (captured) =>
        authserver('refresh', { accessToken: captured.token, selectedProfile: { id: '0'.repeat(32), name: 'Nobody' } }),
      ),
      rejected('别人的角色', (captured) =>
        authserver('refresh', {
          accessToken: captured.token,
          selectedProfile: { id: uuidOf('HDSkin'), name: 'HDSkin' },
        }),
      ),
      validate('token'),
    ],
  },
  {
    id: 'auth/refresh-select-bound',
    title: '令牌已经绑定了角色时再选择，即使是同一个也返回 400',
    steps: [
      login(DAVE, 'token'),
      rejected('选择已经绑定的角色', (captured) =>
        authserver('refresh', { accessToken: captured.token, selectedProfile: { id: uuidOf('Dave'), name: 'Dave' } }),
      ),
    ],
  },
]

const tokenScenarios: ContractScenario[] = [
  {
    id: 'auth/validate',
    title: 'validate：给了 clientToken 就必须一致',
    steps: [
      login(STEVE, 'token', { clientToken: 'client-steve' }),
      validate('token'),
      validate('token', { clientToken: 'client-steve' }),
      validate('token', { clientToken: 'other-client' }),
    ],
  },
  {
    id: 'auth/invalidate',
    title: 'invalidate 不检查 clientToken，令牌不存在也返回 204',
    steps: [
      login(STEVE, 'token', { clientToken: 'client-steve' }),
      {
        title: 'clientToken 不一致也吊销',
        request: (captured) => authserver('invalidate', { accessToken: captured.token, clientToken: 'other-client' }),
      },
      validate('token'),
      { title: '再吊销一次', request: (captured) => authserver('invalidate', { accessToken: captured.token }) },
    ],
  },
  {
    id: 'auth/signout',
    title: 'signout 吊销这个用户的全部令牌',
    steps: [
      login('Alex_01', 'a'),
      login('Steve', 'b'),
      { title: '用邮箱 signout', request: authserver('signout', { username: STEVE, password: PASSWORD }) },
      validate('a'),
      validate('b'),
    ],
  },
  {
    id: 'auth/signout-rejected',
    title: 'signout 密码错误 403，不吊销；用户名为空 400',
    steps: [
      login('Alex_01', 'token'),
      rejected('密码错误', authserver('signout', { username: STEVE, password: 'wrong-password' })),
      rejected('没有用户名', authserver('signout', { password: PASSWORD })),
      validate('token'),
    ],
  },
  {
    id: 'auth/signout-banned',
    title: 'signout 不检查封禁',
    steps: [
      { title: '被封禁的用户 signout', request: authserver('signout', { username: BANNED, password: PASSWORD }) },
    ],
  },
  {
    id: 'auth/signout-throttled',
    title: 'signout 与 authenticate 共用节流',
    steps: [
      login(STEVE, 'token'),
      rejected('马上用同一个邮箱 signout', authserver('signout', { username: STEVE, password: PASSWORD })),
      validate('token'),
    ],
  },
  {
    id: 'auth/signout-player-name',
    title: '用角色名 signout',
    steps: [
      login(STEVE, 'token'),
      { title: '用角色名 signout', request: authserver('signout', { username: 'Alex_01', password: PASSWORD }) },
      {
        ...validate('token'),
        deviation: {
          reason: `${SECURITY_DEVIATION}：BS 按小写的用户名找令牌列表，用角色名 signout 什么也没吊销；NextSkin 吊销`,
          compareWith: 'ygg/validate-unknown',
        },
      },
    ],
  },
]

const sessionScenarios: ContractScenario[] = [
  {
    id: 'session/join',
    title: 'join 之后 hasJoined 返回带签名的资料，120 秒内可以查多次',
    steps: [
      login(DAVE, 'token'),
      { title: 'join', request: join(uuidOf('Dave')) },
      hasJoined('username=Dave&serverId=server-1'),
      hasJoined('username=Dave&serverId=server-1'),
      hasJoined('username=Dave%20&serverId=server-1'),
      hasJoined('username=dave&serverId=server-1'),
      hasJoined('username=Dave&serverId=server-2'),
      hasJoined('username=Dave&serverId=server-1&ip=192.0.2.1'),
    ],
  },
  {
    id: 'session/join-rejected',
    title: 'join：令牌没有绑定角色、绑定的不是这个角色、UUID 大小写不同，都是 403',
    steps: [
      login(STEVE, 'unbound'),
      rejected('令牌没有绑定角色', join(uuidOf('Steve'), 'unbound')),
      login(DAVE, 'bound'),
      rejected('别的角色', join(uuidOf('Steve'), 'bound')),
      rejected('UUID 是大写', join(uuidOf('Dave').toUpperCase(), 'bound')),
      hasJoined('username=Dave&serverId=server-1'),
    ],
  },
  {
    id: 'session/join-after-invalidate',
    title: '令牌吊销以后不能进服',
    steps: [
      login(DAVE, 'token'),
      { title: 'invalidate', request: (captured) => authserver('invalidate', { accessToken: captured.token }) },
      rejected('join', join(uuidOf('Dave'))),
    ],
  },
  {
    id: 'session/join-forwarded-ip',
    title: 'join 请求自带的 X-Forwarded-For',
    steps: [
      login(DAVE, 'token'),
      { title: 'join', request: join(uuidOf('Dave'), 'token', 'server-1', { 'x-forwarded-for': '198.51.100.7' }) },
      {
        ...hasJoined('username=Dave&serverId=server-1&ip=198.51.100.7'),
        deviation: {
          reason: `${SECURITY_DEVIATION}：BS 采信任意来源的转发头；NextSkin 只按受信代理解析客户端 IP`,
          compareWith: 'ygg/has-joined-unknown',
        },
      },
    ],
  },
]

const DAVE_UUID = uuidOf('Dave')
const profileScenarios: ContractScenario[] = [
  {
    id: 'profile/upload-skin',
    title: '上传皮肤',
    steps: [
      login(DAVE, 'token'),
      { title: '上传一张新皮肤', request: upload(DAVE_UUID, 'skin', 'legacy-64x32.png', 'my-skin.png') },
      { title: '上传站内已有的公开皮肤', request: upload(DAVE_UUID, 'skin', 'steve-64x64.png', 'steve.png') },
    ],
  },
  {
    id: 'profile/upload-slim',
    title: '上传 Alex 模型的皮肤',
    steps: [
      login(DAVE, 'token'),
      { title: 'model=slim', request: upload(DAVE_UUID, 'skin', 'alex-64x64.png', 'alex.png', 'slim') },
    ],
  },
  {
    id: 'profile/upload-cape',
    title: '上传披风',
    steps: [login(DAVE, 'token'), { title: '披风', request: upload(DAVE_UUID, 'cape', 'cape-64x32.png', 'cape.png') }],
  },
  {
    id: 'profile/upload-invalid',
    title: '尺寸不对返回 400',
    steps: [
      login(DAVE, 'token'),
      rejected('Alex 模型的 64×32 皮肤', upload(DAVE_UUID, 'skin', 'legacy-64x32.png', 'legacy.png', 'slim')),
      rejected('1:1 的披风', upload(DAVE_UUID, 'cape', 'steve-64x64.png', 'steve.png')),
    ],
  },
  {
    id: 'profile/upload-unknown-profile',
    title: '角色不存在返回 404',
    steps: [
      login(DAVE, 'token'),
      rejected('上传', upload('0'.repeat(32), 'skin', 'steve-64x64.png', 'steve.png')),
      rejected('删除', reset('0'.repeat(32), 'skin')),
    ],
  },
  {
    id: 'profile/upload-others',
    title: '上传别人角色的材质',
    steps: [
      login(DAVE, 'token'),
      {
        title: '给 Steve 上传皮肤',
        request: upload(uuidOf('Steve'), 'skin', 'steve-64x64.png', 'steve.png'),
        body: 'yggdrasil-error',
        deviation: {
          reason: `${SECURITY_DEVIATION}：BS 不检查角色归属，任何人都能改别人角色的材质；NextSkin 返回 403`,
          compareWith: 'ygg/validate-unknown',
        },
      },
    ],
  },
  {
    id: 'profile/delete',
    title: '删除皮肤和披风',
    steps: [
      login(DAVE, 'token'),
      { title: '删除皮肤', request: reset(DAVE_UUID, 'skin') },
      { title: '删除披风', request: reset(DAVE_UUID, 'cape') },
      {
        title: '按 UUID 查角色：没有材质了',
        request: get(`${PROFILE}/${DAVE_UUID}`),
        body: 'yggdrasil-profile',
      },
    ],
  },
  {
    id: 'profile/delete-others',
    title: '删除别人角色的材质',
    steps: [
      login(DAVE, 'token'),
      {
        title: '删除 Steve 的披风',
        request: reset(uuidOf('Steve'), 'cape'),
        body: 'yggdrasil-error',
        deviation: {
          reason: `${SECURITY_DEVIATION}：BS 不检查角色归属；NextSkin 返回 403`,
          compareWith: 'ygg/validate-unknown',
        },
      },
    ],
  },
]

export const scenarios: ContractScenario[] = [
  ...authenticateScenarios,
  ...refreshScenarios,
  ...tokenScenarios,
  ...sessionScenarios,
  ...profileScenarios,
]

/** 合并默认请求头，按前面取到的值填好请求 */
export function resolveStep(step: ScenarioStep, captured: Captured): Required<ContractRequest> {
  const request = typeof step.request === 'function' ? step.request(captured) : step.request
  return {
    method: request.method,
    path: request.path,
    headers: { ...DEFAULT_HEADERS, ...request.headers },
    body: request.body ?? '',
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
for (const [index, scenario] of scenarios.entries()) {
  if (scenarios.findIndex((other) => other.id === scenario.id) !== index || cases.some((c) => c.id === scenario.id))
    throw new Error(`场景 id 重复：${scenario.id}`)
  for (const step of scenario.steps) {
    const target = step.deviation?.compareWith
    if (target !== undefined && !cases.some((other) => other.id === target && !other.deviation))
      throw new Error(`场景 ${scenario.id} 的 compareWith 必须指向一个没有差异的一问一答用例：${target}`)
  }
}
