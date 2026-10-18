import { expect, test } from 'vitest'
import { convertPcre, planSettings } from './settings.ts'

test('PCRE 的正则转成 JS 的写法', () => {
  expect(convertPcre('')).toBe('')
  expect(convertPcre('/^[a-z]+$/')).toBe('^[a-z]+$')
  expect(convertPcre('/^[a-z]+$/iu')).toBe('(?i:^[a-z]+$)')
  expect(convertPcre('#^a\\#b$#ms')).toBe('(?ms:^a#b$)')
  expect(convertPcre('{^\\w+$}')).toBe('^\\w+$')
  expect(convertPcre('/^\\/x$/')).toBe('^\\/x$')
  for (const value of ['^abc$', '/abc/x', '/abc', 'aabca', '/(?<=a/'] as const) expect(convertPcre(value)).toBeNull()
})

function plan(options: Record<string, string>, siteUrl: string | null = null) {
  return planSettings({
    options: new Map(Object.entries(options)),
    timeZone: 'Asia/Shanghai',
    siteUrl,
    salt: '',
    siteLocale: 'zh-CN',
  })
}

test('旧库里没有的选项按 BS 的默认值算；PHP 的布尔和 score_per_storage 的 true', () => {
  const result = plan({})
  expect(result.issues).toEqual([])
  expect(result.report.invalid).toEqual([])
  expect(Object.fromEntries(result.values)).toMatchObject({
    'site.name': 'Blessing Skin',
    'score.perKbPublic': 1,
    'score.perKbPrivate': 10,
    'checkIn.score': { min: 10, max: 100 },
    'auth.registration.withPlayerName': true,
    'player.uuidAlgorithm': 'offline',
    'yggdrasil.tokenValidSeconds': 259200,
  })
  // BS 默认的公告不导入
  expect(result.values.has('site.announcement')).toBe(false)
  expect(result.rules).toEqual({
    scorePerPlayer: 100,
    scorePerClosetItem: 0,
    scorePerKbPublic: 1,
    scorePerKbPrivate: 10,
    takeBackScoresAfterDeletion: true,
    scoreAwardPerTexture: 0,
    reporterScoreModification: 0,
    uuidAlgorithm: 'offline',
  })
  const values = plan({ score_per_storage: 'false', return_score: '0', sign_after_zero: '1' }).values
  expect([
    values.get('score.perKbPublic'),
    values.get('score.refundOnDelete'),
    values.get('checkIn.resetAtMidnight'),
  ]).toEqual([0, false, true])
})

test('超出范围的取边界值，不合法的不导入，都写进报告', () => {
  const result = plan({
    ygg_tokens_limit: '5000',
    ygg_rate_limit: '-1',
    cache_expire_time: 'forever',
    sign_score: '100,10',
    player_name_length_min: '0',
    player_name_length_max: '60',
    ygg_uuid_algorithm: 'v5',
    ygg_private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----',
    site_url: 'not a url',
  })
  expect(result.report.clamped).toEqual([
    { key: 'player.nameLength', from: '0–60', to: '1–50' },
    { key: 'yggdrasil.tokensPerUser', from: '5000', to: '1000' },
    { key: 'yggdrasil.loginIntervalMs', from: '-1', to: '0' },
  ])
  expect(result.report.invalid).toEqual([
    { option: 'cache_expire_time', value: 'forever' },
    { option: 'sign_score', value: '100,10' },
    { option: 'ygg_uuid_algorithm', value: 'v5' },
    { option: 'ygg_private_key', value: '（无法使用：不是 4096 位以上的 RSA 私钥）' },
    { option: 'site.url', value: '"not a url"' },
  ])
  // 机密的值不进报告
  expect(JSON.stringify(result.report)).not.toContain('BEGIN PRIVATE KEY')
  expect(result.values.has('cache.publicMaxAge')).toBe(false)
  expect(result.values.get('player.nameLength')).toEqual({ min: 1, max: 50 })
  // 站点地址以导入时确认的为准
  expect(plan({ site_url: 'not a url' }, 'https://new.example.test').values.get('site.url')).toBe(
    'https://new.example.test',
  )
})

test('举报：负的 reporter_score_modification 是花费，正的并进奖励', () => {
  const cost = plan({ reporter_score_modification: '-5', reporter_reward_score: '2' }).values
  expect([cost.get('report.cost'), cost.get('report.reward')]).toEqual([5, 2])
  const reward = plan({ reporter_score_modification: '3', reporter_reward_score: '2' }).values
  expect([reward.get('report.cost'), reward.get('report.reward')]).toEqual([0, 5])
})

test('公告和内容政策：取站点语言的那份，其他语言列出；含 HTML 的注明；太长的停止', () => {
  const result = plan({
    announcement: 'fallback',
    announcement_zh_CN: '中文 <script>x</script>',
    announcement_en: 'English',
    content_policy: 'policy',
    content_policy_ja_JP: '',
  })
  expect(result.values.get('site.announcement')).toBe('中文 <script>x</script>')
  expect(result.values.get('texture.contentPolicy')).toBe('policy')
  expect(result.report.otherLocales).toEqual(['announcement_en'])
  expect(result.report.rawHtml).toEqual(['announcement_zh_CN'])
  expect(plan({ content_policy: 'x'.repeat(20001) }).issues).toEqual([
    { code: 'text_too_long', option: 'content_policy', length: 20001 },
  ])
  expect(plan({ texture_name_regexp: '/a/x' }).issues).toEqual([
    { code: 'regex_unsupported', option: 'texture_name_regexp', value: '/a/x' },
  ])
})

test('不导入、但改过的设置列出来', () => {
  expect(plan({ allow_downloading_texture: 'false', score_award_per_like: '0' }).report.notImported).toEqual([
    { option: 'allow_downloading_texture', value: 'false' },
  ])
})
