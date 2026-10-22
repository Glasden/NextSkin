import { cx } from '@nextskin/ui'
import repoData from '../gen/repo-data.json'
import { BEAT, barsFrom, EIGHTH, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { abs, icons, Mono, Pill, PixelIcon, Px, Sans, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(17)

const titles = repoData.contractTitles
const TOTAL = titles.length

// 用例和录制结果取自 tests/contract（cases.ts、recordings/bs-v6.json）
interface Card {
  id: string
  request: string
  bs: string
  next: string
  same: boolean
  zh: string
  en: string
}
const cards: Card[] = [
  {
    id: 'csl/trailing-space',
    request: 'GET /csl/Steve%20.json',
    bs: '200',
    next: '200',
    same: true,
    zh: '名字末尾多一个空格，照样查得到',
    en: "MySQL's PAD SPACE ignores trailing spaces — so do we",
  },
  {
    id: 'ygg/single',
    request: 'GET /api/yggdrasil/api/users/profiles/minecraft/steve',
    bs: '200',
    next: '200',
    same: true,
    zh: '返回请求里的 steve，不是角色名 Steve',
    en: 'Echoes the name you asked for, not the stored one',
  },
  {
    id: 'auth/authenticate-request-user',
    request: 'POST /api/yggdrasil/authserver/authenticate {"requestUser":"false",…}',
    bs: '200',
    next: '200',
    same: true,
    zh: '字符串 "false" 按 PHP 的规则算真',
    en: 'The string "false" is truthy, the PHP way',
  },
  {
    id: 'profile/upload-others',
    request: 'PUT /api/yggdrasil/api/user/profile/{Steve 的 UUID}/skin · 令牌是 Dave 的',
    bs: '204',
    next: '403',
    same: false,
    zh: '用自己的令牌改别人的皮肤：拒绝',
    en: "Changing someone else's skin with your token: denied",
  },
  {
    id: 'auth/signout-player-name',
    request: 'POST /api/yggdrasil/authserver/signout {"username":"Alex_01"} → validate',
    bs: '204',
    next: '403',
    same: false,
    zh: '用角色名退出登录，真的吊销令牌',
    en: 'Signing out by player name actually revokes the tokens',
  },
]

const ROW = 62
const TOP = 214
const BLOCKS = 48
const RUN = at(18, 3)
const RUN_END = at(20, 3)
// 前面慢、后面快：计数按时间的 1.5 次方走，最后正好跑完全部用例
const doneAt = (t: number) =>
  t < RUN ? 0 : Math.min(TOTAL, Math.round(TOTAL * Math.pow((t - RUN) / (RUN_END - RUN), 1.5)))

/** 契约用例对照 BS v6 的录制回放：照样复现的怪癖、有意修掉的漏洞同屏摆开，再跑完全部用例 */
function Contract() {
  const t = useT()
  const done = doneAt(t)
  const complete = done === TOTAL
  const filled = Math.floor((BLOCKS * done) / TOTAL)

  return (
    <Scene>
      <Title zh="连 BS 的怪癖都照样复现，漏洞不复现" en="Its quirks are reproduced. Its security holes are not." />
      <div style={abs(64, TOP, { width: 1152 })}>
        {cards.map((card, i) => {
          const start = at(17) + i * BEAT
          const fixed = !card.same
          return (
            <div
              key={card.id}
              className="flex items-center border-t border-border"
              style={{ height: ROW, gap: 20, ...enter(t, start, 12) }}
            >
              <div style={{ width: 168 }}>
                <Pill tone={fixed ? 'warning' : 'success'} size={12}>
                  {fixed ? '有意修复 FIXED' : '照样复现 REPRODUCED'}
                </Pill>
              </div>
              <div className="min-w-0 flex-1">
                <Px size={24}>{card.zh}</Px>
                <Mono size={13} tone="muted" className="truncate">
                  {card.request}
                </Mono>
              </div>
              <div className="flex items-center" style={{ gap: 12, width: 300, justifyContent: 'flex-end' }}>
                <Px size={12} tone="muted">
                  BS v6
                </Px>
                <Pill tone={fixed ? 'danger' : 'success'}>{card.bs}</Pill>
                <div style={{ width: 40, textAlign: 'center', ...enter(t, start + EIGHTH, 0) }}>
                  <Px size={36} tone={fixed ? 'warning' : 'success'}>
                    {fixed ? '≠' : '='}
                  </Px>
                </div>
                <div className="flex items-center" style={{ gap: 12, ...enter(t, start + EIGHTH, 0) }}>
                  <Pill tone={fixed ? 'accent' : 'success'}>{card.next}</Pill>
                  <Px size={12} tone="muted">
                    NextSkin
                  </Px>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div
        className="border-t border-border"
        style={abs(64, TOP + cards.length * ROW, { width: 1152, ...enter(t, RUN) })}
      >
        <div className="flex items-end" style={{ gap: 24, marginTop: 12 }}>
          <div className="flex items-baseline" style={{ gap: 12 }}>
            <Px size={60} tone={complete ? 'accent' : 'text'}>
              {String(done).padStart(3, '0')}
            </Px>
            <Px size={24} tone="muted">
              / {TOTAL}
            </Px>
          </div>
          <div style={{ paddingBottom: 8 }}>
            <Px size={24}>
              {repoData.contractCases} 个用例 · {repoData.contractScenarios} 个场景，对照真实 BS v6 的录制回放
            </Px>
            <div className="flex items-center" style={{ gap: 10, height: 24 }}>
              {done > 0 && <PixelIcon rows={icons.check} cell={2} tone="success" />}
              <Sans size={15} tone="muted" style={{ whiteSpace: 'nowrap' }}>
                {done > 0 ? titles[done - 1] : ''}
              </Sans>
            </div>
          </div>
        </div>
        <div className="flex items-center" style={{ gap: 4, marginTop: 8 }}>
          {Array.from({ length: BLOCKS }, (_, i) => (
            <div
              key={i}
              className={cx(i < filled ? 'bg-accent' : 'border border-border bg-surface-sunken')}
              style={{ width: 14, height: 24 }}
            />
          ))}
          <div style={{ marginLeft: 16, visibility: complete ? 'visible' : 'hidden' }}>
            <Pill tone="success">PASS · 全部通过</Pill>
          </div>
        </div>
      </div>
    </Scene>
  )
}

export const contract: Page = {
  id: 'contract',
  Scene: Contract,
  duration: RUN_END + SIXTEENTH,
  hold: 6,
  chapter: { no: '07', zh: '契约', en: 'CONTRACT' },
  text: {
    title: '连 BS 的怪癖都照样复现，漏洞不复现',
    en: 'Its quirks are reproduced. Its security holes are not.',
    body: [
      `协议端点有 ${TOTAL} 条契约用例：请求从真实的 Blessing Skin v6 录下响应，NextSkin 回放同样的请求逐项比较。玩家的模组和启动器依赖的怪癖也照样复现，比如角色名末尾多一个空格照样查得到、字符串 "false" 按 PHP 的规则算真。`,
      '安全漏洞是例外：用自己的令牌改别人的皮肤、按角色名退出登录却不吊销令牌，这些在 NextSkin 里有意修掉了，用例里写明了和 BS 的差别。',
    ],
  },
}
