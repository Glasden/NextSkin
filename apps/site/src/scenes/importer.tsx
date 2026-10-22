import { cx } from '@nextskin/ui'
import { barsFrom, EIGHTH, enter, random, SIXTEENTH, steps, useT } from '../stage/time.ts'
import { abs, Mark, Mono, Panel, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(12)

// docs/schema.md 的"从 BS 导入"对照表
const tables = [
  ['users', 'users · accounts · score_transactions'],
  ['players', 'players'],
  ['uuid', 'players.uuid（原样保留）'],
  ['textures', 'texture_files · textures'],
  ['user_closet', 'closet_items'],
  ['options', 'settings'],
] as const

// 示例角色，名字是虚构的
const players = ['PixelFox', 'Moss_02', 'kiri', 'LanternBug', 'oak_and_ash', 'Nimbus7', 'SnowPea', 'TideCaller']
const hex = (seed: number, n: number) =>
  Array.from({ length: n }, (_, i) => Math.floor(random(seed * 31 + i) * 16).toString(16)).join('')

const ROW = 34
const TOP = 230
const LEFT = { x: 64, w: 230 }
const RIGHT = { x: 800, w: 416 }
const LANE = { from: LEFT.x + LEFT.w + 20, to: RIGHT.x - 60 }
const CHECK = EIGHTH * 0.75
const COMMIT = at(13, 4)

/** BS 的表在一个事务里整库换进 NextSkin；提交之前在同一个事务里把全部角色读回来和旧库比对，最后 COMMIT */
function Importer() {
  const t = useT()
  const committed = t >= COMMIT
  const checked = Math.max(0, Math.min(players.length, Math.floor((t - at(13)) / CHECK) + 1))
  const bottom = TOP + 40 + tables.length * ROW

  return (
    <Scene>
      <Title zh="从 BS 迁移：一个事务，全有或全无" en="Migrating from BS: one transaction, all or nothing" />
      <div style={abs(LEFT.x, TOP, { width: LEFT.w })}>
        <Px size={12} tone="muted" style={{ height: 40 }}>
          BS v6 · 只读
        </Px>
        {tables.map(([from]) => (
          <Mono key={from} size={16} style={{ height: ROW }}>
            {from}
          </Mono>
        ))}
      </div>
      <div style={abs(RIGHT.x, TOP, { width: RIGHT.w })}>
        <Px size={12} tone="muted" style={{ height: 40 }}>
          NEXTSKIN
        </Px>
        {tables.map(([from, to], i) => (
          <Mono
            key={from}
            size={16}
            tone={i === 2 ? 'accent' : 'text'}
            style={{ height: ROW, ...enter(t, at(12) + i * EIGHTH + EIGHTH / 2, 0) }}
          >
            {to}
          </Mono>
        ))}
      </div>
      {/* 事务：BEGIN 一直开着，到最后才提交 */}
      <div
        className={cx('border-2 border-dashed', committed ? 'border-success' : 'border-accent')}
        style={abs(LANE.from - 8, TOP - 4, { width: LANE.to - LANE.from + 32, height: bottom - TOP + 8 })}
      />
      <div style={abs(LANE.from, TOP + 2)}>
        <Mono size={14} tone="accent">
          BEGIN
        </Mono>
      </div>
      {tables.map(([from], i) => {
        const start = at(12) + i * EIGHTH
        if (t < start) return null
        const p = steps(t, start, EIGHTH, 4)
        const x = LANE.from + 70 + p * (LANE.to - LANE.from - 110)
        return (
          <div key={from} className="flex" style={abs(Math.round(x), TOP + 40 + i * ROW + 4, { gap: 3 })}>
            {[0, 1, 2, 3].map((k) => (
              <div key={k} className="bg-accent" style={{ width: 10, height: 14, opacity: p === 1 ? 0.45 : 1 }} />
            ))}
          </div>
        )
      })}
      <div style={abs(LANE.from, bottom - 26)}>
        <Mono size={14} tone={committed ? 'success' : 'muted'}>
          {committed ? 'COMMIT' : '…'}
        </Mono>
      </div>

      <div style={abs(64, 492, { width: 1152, ...enter(t, at(13)) })}>
        <Panel bg="sunken" shadow={4} className="flex" style={{ height: 172, padding: '16px 24px', gap: 32 }}>
          <div style={{ width: 380 }}>
            <Px size={24}>提交之前，把全部角色读回来比对</Px>
            <Px size={12} tone="muted" style={{ marginTop: 6 }}>
              EVERY PLAYER IS READ BACK AND CHECKED BEFORE COMMIT
            </Px>
            <Mono size={15} style={{ marginTop: 18 }}>
              <span className="text-accent">$ </span>node nextskin.mjs import blessing-skin
            </Mono>
            <Px size={12} tone="muted" style={{ marginTop: 4 }}>
              安装向导里也能点 · 对不上就整体回滚
            </Px>
          </div>
          <div className="flex-1 overflow-hidden" style={{ height: 140 }}>
            {players.slice(Math.max(0, checked - 4), checked).map((name) => {
              const i = players.indexOf(name)
              return (
                <div key={name} className="flex items-center" style={{ gap: 16, height: 34 }}>
                  <Mono size={15} style={{ width: 120 }}>
                    {name}
                  </Mono>
                  <Mono size={14} tone="muted" style={{ width: 300 }}>
                    {hex(i, 8)}-{hex(i + 50, 4)}-{hex(i + 90, 4)}-…
                  </Mono>
                  {['UUID', '皮肤', '披风', '模型'].map((label, k) => (
                    <div
                      key={label}
                      className="flex items-center"
                      style={{ gap: 6, ...enter(t, at(13) + i * CHECK + (k * SIXTEENTH) / 4, 0) }}
                    >
                      <Mark ok cell={2} />
                      <Px size={12}>{label}</Px>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        </Panel>
      </div>
    </Scene>
  )
}

export const importer: Page = {
  id: 'import',
  Scene: Importer,
  duration: COMMIT + SIXTEENTH,
  hold: 4,
  chapter: { no: '02', zh: '兼容', en: 'COMPATIBLE' },
  text: {
    title: '从 BS 迁移：一个事务，全有或全无',
    en: 'Migrating from BS: one transaction, all or nothing',
    body: [
      '`node nextskin.mjs import blessing-skin` 只读地连上 Blessing Skin v6 的数据库，把用户、角色、材质、衣柜和站点设置在一个事务里整体导入；安装向导里也能直接点。',
      '提交之前，在同一个事务里把每个角色读回来和旧库逐项比对：UUID、皮肤、披风、模型。有一项对不上就整体回滚，不会留下导了一半的站点。',
    ],
  },
}
