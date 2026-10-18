// options → settings（docs/schema.md 的对照表）。只导入有对应设置项的键；旧库里没有的选项按 BS 的默认值算
import { coreSettingsRegistry, parseSigningKey, type CoreSettingKey, type Locale } from '@nextskin/domain/importer'
import type { BlockingIssue, ImportReport } from './report.ts'

const MAX_INT = 2147483647

/** BS 6.0.2 的 config/options.php 和 yggdrasil-api / yggdrasil-connect 启用时写入的默认值 */
const BS_DEFAULTS: Record<string, string> = {
  site_url: '',
  site_name: 'Blessing Skin',
  register_with_player_name: 'true',
  require_verification: 'false',
  regs_per_ip: '3',
  announcement: 'Welcome to Blessing Skin {version}!',
  player_name_rule: 'official',
  custom_player_name_regexp: '',
  player_name_length_min: '3',
  player_name_length_max: '16',
  user_initial_score: '1000',
  sign_gap_time: '24',
  sign_score: '10,100',
  score_per_storage: 'true',
  private_score_per_storage: '10',
  return_score: 'true',
  score_per_player: '100',
  sign_after_zero: 'false',
  auto_del_invalid_texture: 'false',
  allow_downloading_texture: 'true',
  texture_name_regexp: '',
  cache_expire_time: '31536000',
  max_upload_file_size: '1024',
  score_per_closet_item: '0',
  score_award_per_texture: '0',
  take_back_scores_after_deletion: 'true',
  score_award_per_like: '0',
  reporter_score_modification: '0',
  reporter_reward_score: '0',
  content_policy: '',
  status_code_for_private: '403',
  ygg_uuid_algorithm: 'v3',
  ygg_token_expire_1: '259200',
  ygg_token_expire_2: '604800',
  ygg_tokens_limit: '10',
  ygg_rate_limit: '1000',
  ygg_skin_domain: '',
  ygg_search_profile_max: '5',
  ygg_private_key: '',
  ygg_enable_ali: 'true',
}

/** 不导入的设置：不是默认值时在报告里列出（ADR-0025、ADR-0026） */
const NOT_IMPORTED = [
  'score_award_per_texture',
  'take_back_scores_after_deletion',
  'score_award_per_like',
  'status_code_for_private',
  'auto_del_invalid_texture',
  'allow_downloading_texture',
]

/** 导入器写的设置项：每次导入先删掉这些键，再写入和默认值不同的。其余的键是新站自己的配置，保留 */
export const IMPORTED_SETTING_KEYS = [
  'site.url',
  'site.name',
  'site.timeZone',
  'site.announcement',
  'cache.publicMaxAge',
  'auth.registration.withPlayerName',
  'auth.registration.perIpLimit',
  'auth.requireEmailVerification',
  'auth.legacyPasswordSalt',
  'user.initialScore',
  'score.perPlayer',
  'score.perKbPublic',
  'score.perKbPrivate',
  'score.perClosetItem',
  'score.refundOnDelete',
  'checkIn.score',
  'checkIn.gapHours',
  'checkIn.resetAtMidnight',
  'report.cost',
  'report.reward',
  'player.nameRule',
  'player.nameRegex',
  'player.nameLength',
  'player.uuidAlgorithm',
  'texture.maxFileSizeKb',
  'texture.nameRegex',
  'texture.contentPolicy',
  'yggdrasil.signingKey',
  'yggdrasil.skinDomains',
  'yggdrasil.profileSearchLimit',
  'yggdrasil.apiLocationIndication',
  'yggdrasil.tokenValidSeconds',
  'yggdrasil.tokenRefreshableSeconds',
  'yggdrasil.tokensPerUser',
  'yggdrasil.loginIntervalMs',
] as const satisfies readonly CoreSettingKey[]

/** 导入各表时要用的旧站规则，按 BS 运行时的取值（不是转换成 NextSkin 设置之后的值） */
export interface BsRules {
  scorePerPlayer: number
  scorePerClosetItem: number
  scorePerKbPublic: number
  scorePerKbPrivate: number
  takeBackScoresAfterDeletion: boolean
  scoreAwardPerTexture: number
  reporterScoreModification: number
  uuidAlgorithm: 'offline' | 'random'
}

export interface SettingsPlan {
  values: Map<CoreSettingKey, unknown>
  rules: BsRules
  report: ImportReport['settings']
  issues: BlockingIssue[]
}

/** BS 的 Option::get：字符串 'true'、'false' 读成布尔，其余原样 */
function phpTruthy(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  return value !== '' && value !== '0'
}

function parseInteger(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return null
  const number = Number(trimmed)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * PCRE 的正则（带分隔符和修饰符，BS 用 preg_match）转成 JS 的写法，按 `new RegExp(…, 'u')` 使用。
 * 修饰符 i、m、s 转成 `(?ims:…)`，u 本来就开着；其他修饰符、JS 编译不了的写法返回 null
 */
export function convertPcre(value: string): string | null {
  if (value === '') return ''
  const delimiter = value[0]!
  if (/[A-Za-z0-9\\\s]/.test(delimiter)) return null
  const closing = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[delimiter] ?? delimiter
  const end = value.lastIndexOf(closing)
  if (end <= 0) return null
  let pattern = value.slice(1, end)
  const modifiers = value.slice(end + 1)
  if (!/^[imsu]*$/.test(modifiers)) return null
  // 分隔符在正则里要转义；JS 的 u 模式只允许转义语法字符和 /，其余的去掉反斜杠
  if (!/[\^$\\.*+?()[\]{}|/]/.test(delimiter)) pattern = pattern.replaceAll(`\\${delimiter}`, delimiter)
  if (closing !== delimiter && !/[\^$\\.*+?()[\]{}|/]/.test(closing))
    pattern = pattern.replaceAll(`\\${closing}`, closing)
  const flags = [...new Set(modifiers.replaceAll('u', ''))].sort().join('')
  const converted = flags ? `(?${flags}:${pattern})` : pattern
  try {
    new RegExp(converted, 'u')
    return converted
  } catch {
    return null
  }
}

const DEFAULT_ANNOUNCEMENT = /^Welcome to Blessing Skin (?:\{version\}|\S+)!$/
const RAW_HTML = /<(?:[A-Za-z][^>]*|\/[A-Za-z][^>]*|!--[\s\S]*?--)>/

export function planSettings(input: {
  options: ReadonlyMap<string, string>
  timeZone: string
  siteUrl: string | null
  salt: string
  siteLocale: Locale
}): SettingsPlan {
  const { options } = input
  const values = new Map<CoreSettingKey, unknown>()
  const report: ImportReport['settings'] = {
    imported: [],
    clamped: [],
    invalid: [],
    notImported: [],
    otherLocales: [],
    rawHtml: [],
  }
  const issues: BlockingIssue[] = []
  const option = (name: string) => options.get(name) ?? BS_DEFAULTS[name] ?? ''
  const invalid = (name: string, value = option(name)): void => {
    report.invalid.push({ option: name, value })
  }

  function integer(key: CoreSettingKey, name: string, min: number, max: number): void {
    const parsed = parseInteger(option(name))
    if (parsed === null) return invalid(name)
    const clamped = Math.min(max, Math.max(min, parsed))
    if (clamped !== parsed) report.clamped.push({ key, from: String(parsed), to: String(clamped) })
    values.set(key, clamped)
  }
  const flag = (key: CoreSettingKey, name: string) => values.set(key, phpTruthy(option(name)))
  const rule = (name: string, fallback: number) =>
    parseInteger(option(name)) ?? parseInteger(BS_DEFAULTS[name]!) ?? fallback

  // 站点
  const siteUrl = input.siteUrl ?? option('site_url').trim().replace(/\/+$/, '')
  values.set('site.url', siteUrl)
  values.set('site.name', option('site_name'))
  values.set('site.timeZone', input.timeZone)
  integer('cache.publicMaxAge', 'cache_expire_time', 0, Number.MAX_SAFE_INTEGER)

  // 注册
  flag('auth.registration.withPlayerName', 'register_with_player_name')
  flag('auth.requireEmailVerification', 'require_verification')
  integer('auth.registration.perIpLimit', 'regs_per_ip', 0, Number.MAX_SAFE_INTEGER)
  if (input.salt) values.set('auth.legacyPasswordSalt', input.salt)

  // 积分
  integer('user.initialScore', 'user_initial_score', 0, MAX_INT)
  integer('score.perPlayer', 'score_per_player', 0, MAX_INT)
  // BS 的默认值是字符串 'true'，Option::get 读成 true，乘法里当 1 用
  const perStorage = option('score_per_storage')
  if (perStorage === 'true' || perStorage === 'false') values.set('score.perKbPublic', perStorage === 'true' ? 1 : 0)
  else integer('score.perKbPublic', 'score_per_storage', 0, MAX_INT)
  integer('score.perKbPrivate', 'private_score_per_storage', 0, MAX_INT)
  integer('score.perClosetItem', 'score_per_closet_item', 0, MAX_INT)
  flag('score.refundOnDelete', 'return_score')
  const signScore = option('sign_score').split(',')
  const signMin = signScore.length === 2 ? parseInteger(signScore[0]!) : null
  const signMax = signScore.length === 2 ? parseInteger(signScore[1]!) : null
  if (signMin === null || signMax === null || signMin < 0 || signMin > signMax || signMax > MAX_INT)
    invalid('sign_score')
  else values.set('checkIn.score', { min: signMin, max: signMax })
  integer('checkIn.gapHours', 'sign_gap_time', 0, Number.MAX_SAFE_INTEGER)
  flag('checkIn.resetAtMidnight', 'sign_after_zero')
  // 举报：BS 提交就发、驳回时收回的奖励，改成采纳时才发（ADR-0026）
  const modification = parseInteger(option('reporter_score_modification'))
  const reward = parseInteger(option('reporter_reward_score'))
  if (modification === null) invalid('reporter_score_modification')
  if (reward === null) invalid('reporter_reward_score')
  if (modification !== null && reward !== null) {
    values.set('report.cost', Math.min(MAX_INT, modification < 0 ? -modification : 0))
    values.set('report.reward', Math.min(MAX_INT, Math.max(0, reward + Math.max(0, modification))))
  }

  // 角色名和材质
  const nameRule = option('player_name_rule')
  if (['official', 'cjk', 'utf8', 'custom'].includes(nameRule)) values.set('player.nameRule', nameRule)
  else invalid('player_name_rule')
  for (const [key, name] of [
    ['player.nameRegex', 'custom_player_name_regexp'],
    ['texture.nameRegex', 'texture_name_regexp'],
  ] as const) {
    const converted = convertPcre(option(name))
    if (converted === null) issues.push({ code: 'regex_unsupported', option: name, value: option(name) })
    else values.set(key, converted)
  }
  const lengthMin = parseInteger(option('player_name_length_min'))
  const lengthMax = parseInteger(option('player_name_length_max'))
  if (lengthMin === null || lengthMax === null)
    invalid('player_name_length_max', `${option('player_name_length_min')},${option('player_name_length_max')}`)
  else {
    const min = Math.min(50, Math.max(1, lengthMin))
    const max = Math.min(50, Math.max(1, lengthMax))
    if (min !== lengthMin || max !== lengthMax)
      report.clamped.push({ key: 'player.nameLength', from: `${lengthMin}–${lengthMax}`, to: `${min}–${max}` })
    if (min > max) invalid('player_name_length_max', `${lengthMin},${lengthMax}`)
    else values.set('player.nameLength', { min, max })
  }
  integer('texture.maxFileSizeKb', 'max_upload_file_size', 1, 8192)

  // Yggdrasil
  const algorithm = option('ygg_uuid_algorithm')
  if (algorithm !== 'v3' && algorithm !== 'v4') invalid('ygg_uuid_algorithm')
  const uuidAlgorithm = algorithm === 'v4' ? 'random' : 'offline'
  values.set('player.uuidAlgorithm', uuidAlgorithm)
  const privateKey = option('ygg_private_key').trim()
  if (privateKey) {
    // 机密项：报告里不写它的值
    if (parseSigningKey(privateKey)) values.set('yggdrasil.signingKey', privateKey)
    else invalid('ygg_private_key', '（无法使用：不是 4096 位以上的 RSA 私钥）')
  }
  values.set(
    'yggdrasil.skinDomains',
    option('ygg_skin_domain')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
  )
  integer('yggdrasil.profileSearchLimit', 'ygg_search_profile_max', 1, Number.MAX_SAFE_INTEGER)
  flag('yggdrasil.apiLocationIndication', 'ygg_enable_ali')
  integer('yggdrasil.tokenValidSeconds', 'ygg_token_expire_1', 1, 31536000)
  integer('yggdrasil.tokenRefreshableSeconds', 'ygg_token_expire_2', 1, 31536000)
  integer('yggdrasil.tokensPerUser', 'ygg_tokens_limit', 1, 1000)
  integer('yggdrasil.loginIntervalMs', 'ygg_rate_limit', 0, 600000)

  // 公告和内容政策：取与 site.locale 对应的那份，没有就取不带后缀的
  const suffix = input.siteLocale.replace('-', '_')
  for (const [key, base] of [
    ['site.announcement', 'announcement'],
    ['texture.contentPolicy', 'content_policy'],
  ] as const) {
    const localized = `${base}_${suffix}`
    const chosen = options.has(localized) ? localized : base
    for (const name of [...options.keys()].sort())
      if (name.startsWith(`${base}_`) && name !== chosen && options.get(name)?.trim()) report.otherLocales.push(name)
    const text = option(chosen)
    if (base === 'announcement' && DEFAULT_ANNOUNCEMENT.test(text.trim())) continue
    if (text.length > 20000) {
      issues.push({ code: 'text_too_long', option: chosen, length: text.length })
      continue
    }
    if (RAW_HTML.test(text)) report.rawHtml.push(chosen)
    values.set(key, text)
  }

  for (const name of NOT_IMPORTED)
    if (option(name) !== BS_DEFAULTS[name]) report.notImported.push({ option: name, value: option(name) })

  // 最后按注册表的类型和检查再过一遍，不合格的不写
  for (const [key, value] of values) {
    const definition = coreSettingsRegistry[key] as {
      schema: { safeParse(value: unknown): { success: boolean } }
      check?: (value: never) => boolean
    }
    if (!definition.schema.safeParse(value).success || (definition.check && !definition.check(value as never))) {
      values.delete(key)
      if (key !== 'yggdrasil.signingKey') invalid(key, JSON.stringify(value))
    }
  }
  report.imported = [...values.keys()].filter((key) => key !== 'auth.legacyPasswordSalt').sort()

  return {
    values,
    report,
    issues,
    rules: {
      scorePerPlayer: rule('score_per_player', 100),
      scorePerClosetItem: rule('score_per_closet_item', 0),
      scorePerKbPublic: perStorage === 'true' ? 1 : perStorage === 'false' ? 0 : rule('score_per_storage', 1),
      scorePerKbPrivate: rule('private_score_per_storage', 10),
      takeBackScoresAfterDeletion: phpTruthy(option('take_back_scores_after_deletion')),
      scoreAwardPerTexture: rule('score_award_per_texture', 0),
      reporterScoreModification: rule('reporter_score_modification', 0),
      uuidAlgorithm,
    },
  }
}
