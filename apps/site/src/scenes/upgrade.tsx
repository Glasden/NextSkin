import { cx } from '@nextskin/ui'
import type { ReactNode } from 'react'
import repoData from '../gen/repo-data.json'
import { barsFrom, EIGHTH, enter, SIXTEENTH, steps, useT } from '../stage/time.ts'
import { abs, icons, Mark, Mono, Panel, PixelIcon, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

// 介绍视频里没有这一段，小节号从 1 数
const at = barsFrom(1)

const { from: OLD, to: NEW } = repoData.upgrade

const PREPARE = at(1, 2)
const APPLY = at(3, 2)
const SWITCH = at(3, 4)
const DOWN = APPLY + EIGHTH
const UP = at(4, 2)
const END = at(4, 4)

// 后台"更新"页的两步（docs/guide/upgrade.md、ADR-0061"升级的流水线"）
const prepare = [
  { zh: '下载', note: `nextskin-${NEW}.zip`, done: at(2, 1) },
  { zh: '核对签名', note: 'ed25519 · SHA-256', done: at(2, 2) },
  { zh: '解压', note: `releases/${NEW}/`, done: at(2, 3) },
  { zh: '预检', note: 'doctor --json，只读', done: at(3, 1) },
]
const apply = [
  { zh: '停掉旧版本', note: '经 IPC 按顺序停下', done: at(3, 3) },
  { zh: '迁移', note: 'migrate --json', done: SWITCH },
  { zh: '换指针', note: `current.json → ${NEW}`, done: SWITCH + EIGHTH },
  { zh: '健康检查', note: '/api/health → 200', done: UP },
]

const LEFT = { x: 64, w: 600 }
const ROW = 32
const BOX = { x: 904, w: 312, h: 116, y: [256, 392] as const }

// 站点在线的格子：停站的那段在画面上要放慢讲，格子按实测的比例只占几格（准备约 8 秒，停站 1–3 秒）
const CELLS = 52
const OFFLINE = 4
const AFTER = 6
const BEFORE = CELLS - OFFLINE - AFTER

// 鼠标指针：外框和里面的填色分两层，亮暗模式下都看得清
const cursor = {
  edge: [
    '#..........',
    '##.........',
    '#.#........',
    '#..#.......',
    '#...#......',
    '#....#.....',
    '#.....#....',
    '#......#...',
    '#.......#..',
    '#........#.',
    '#.....#####',
    '#..#..#....',
    '#.#.#..#...',
    '##..#..#...',
    '#....#..#..',
    '.....#..#..',
    '......##...',
  ],
  fill: [
    '...........',
    '...........',
    '.#.........',
    '.##........',
    '.###.......',
    '.####......',
    '.#####.....',
    '.######....',
    '.#######...',
    '.########..',
    '.#####.....',
    '.##.##.....',
    '.#...##....',
    '.....##....',
    '......##...',
    '......##...',
    '...........',
  ],
}

/**
 * 后台点两下：准备时站点照常运行（下载、核对签名、解压、预检），升级时才停站（停旧版本、迁移、换指针、
 * 等健康检查）。右边是 releases/ 和 current.json 这个指针，底下是站点在线的格子
 */
function Upgrade() {
  const t = useT()
  const switched = steps(t, SWITCH, EIGHTH)
  const down = t >= DOWN && t < UP
  return (
    <Scene>
      <Title zh="一键升级，准备好了才停站" en="One-click upgrades. The site stays up until it's ready." />

      <div style={abs(LEFT.x, 224, { width: LEFT.w })}>
        <Step
          label={`准备升级到 ${NEW}`}
          note="站点照常运行 · SITE STAYS UP"
          press={PREPARE}
          ready={0}
          rows={prepare}
          start={PREPARE}
        />
        <div style={{ marginTop: 16 }}>
          <Step
            label={`升级到 ${NEW}`}
            note="这时才停站 · DOWNTIME STARTS HERE"
            press={APPLY}
            ready={prepare.at(-1)!.done}
            rows={apply}
            start={APPLY}
          />
        </div>
      </div>

      <Mono size={18} tone="muted" style={abs(704, 220)}>
        nextskin/releases/
      </Mono>
      <Version
        y={BOX.y[0]}
        name={OLD}
        current={switched < 1}
        status={
          t < DOWN ? <Running /> : switched < 1 ? <State>已停止 · STOPPED</State> : <State>上一个版本，留作回滚</State>
        }
      />
      {t < PREPARE + EIGHTH ? (
        <div
          className="border border-dashed border-border"
          style={abs(BOX.x, BOX.y[1], { width: BOX.w, height: BOX.h })}
        />
      ) : t < prepare[2]!.done ? (
        <Staging />
      ) : (
        <Version
          y={BOX.y[1]}
          name={NEW}
          current={switched === 1}
          status={
            t >= UP ? (
              <Running />
            ) : switched === 1 ? (
              <State>启动中 · STARTING</State>
            ) : t >= apply[0]!.done ? (
              <State>迁移中 · MIGRATING</State>
            ) : t >= prepare[3]!.done ? (
              <State tone="success">预检通过 · READY</State>
            ) : (
              <State>预检中 · CHECKING</State>
            )
          }
        />
      )}
      {/* current.json：升级就是把它从旧版本挪到新版本 */}
      <div style={abs(704, BOX.y[0] + 26 + switched * (BOX.y[1] - BOX.y[0]))}>
        <div className="flex items-center">
          <Panel bg="accent" edge="accent" shadow={2} style={{ width: 168, padding: '6px 12px' }}>
            <Mono size={15} tone="accent-fg">
              current.json
            </Mono>
            <Mono size={18} tone="accent-fg">
              {JSON.stringify(switched === 1 ? NEW : OLD)}
            </Mono>
          </Panel>
          <div style={{ marginLeft: 8 }}>
            <PixelIcon rows={icons.arrow} cell={3} tone="accent" />
          </div>
        </div>
      </div>

      <div style={abs(704, 532, { width: 512, ...enter(t, at(4, 3)) })}>
        <Panel bg="accent" edge="accent" shadow={4} style={{ padding: '8px 16px' }}>
          <Px size={24} tone="accent-fg">
            新版本没起来，自动换回 {OLD}
          </Px>
          <Px size={12} tone="accent-fg" style={{ opacity: 0.75 }}>
            SQLite 连同迁移前的备份一起换回 · 外部库有迁移时先确认备份
          </Px>
        </Panel>
      </div>

      <Uptime t={t} down={down} />

      <Cursor t={t} x={LEFT.x + 150} y={224 + 18} from={0} press={PREPARE} />
      <Cursor t={t} x={LEFT.x + 110} y={224 + 40 + 12 + 4 * ROW + 16 + 18} from={at(3, 1)} press={APPLY} />
    </Scene>
  )
}

/** 一步：按钮和它下面的几行。按钮在 ready 以前是灰的，press 时按下去；每行在上一行完成后开始 */
function Step({
  label,
  note,
  press,
  ready,
  rows,
  start,
}: {
  label: string
  note: string
  press: number
  ready: number
  rows: readonly { zh: string; note: string; done: number }[]
  start: number
}) {
  const t = useT()
  const enabled = t >= ready
  const pressed = t >= press && t < press + EIGHTH
  return (
    <>
      <div className="flex items-center" style={{ gap: 20, height: 40 }}>
        <div
          className={cx(
            'border',
            enabled ? 'border-accent bg-accent' : 'border-border bg-surface-sunken',
            enabled && !pressed && 'shadow-pixel',
          )}
          style={{ padding: '3px 14px', transform: pressed ? 'translate(2px, 2px)' : undefined }}
        >
          <Px size={24} tone={enabled ? 'accent-fg' : 'muted'}>
            {label}
          </Px>
        </div>
        <Px size={12} tone="muted">
          {note}
        </Px>
      </div>
      <div style={{ marginTop: 12 }}>
        {rows.map((row, i) => {
          const begin = i === 0 ? start + SIXTEENTH : rows[i - 1]!.done
          const state = t >= row.done ? 'done' : t >= begin ? 'running' : 'pending'
          return (
            <div key={row.zh} className="flex items-center" style={{ height: ROW, gap: 12 }}>
              <div className="flex items-center justify-center" style={{ width: 16 }}>
                {state === 'done' ? (
                  <Mark ok cell={2} />
                ) : (
                  <div
                    className={cx(state === 'running' ? 'bg-accent' : 'border border-dashed border-border')}
                    style={{ width: 12, height: 12 }}
                  />
                )}
              </div>
              <Px size={24} tone={state === 'pending' ? 'muted' : 'text'} style={{ width: 132 }}>
                {row.zh}
              </Px>
              <Mono size={15} tone="muted">
                {row.note}
              </Mono>
            </div>
          )
        })}
      </div>
    </>
  )
}

function Version({ y, name, current, status }: { y: number; name: string; current: boolean; status: ReactNode }) {
  return (
    <div style={abs(BOX.x, y)}>
      <Panel
        bg={current ? 'surface' : 'sunken'}
        edge={current ? 'accent' : 'border'}
        thick={current}
        shadow={current ? 4 : 0}
        style={{ width: BOX.w, height: BOX.h, padding: '10px 16px' }}
      >
        <Mono size={24} tone={current ? 'text' : 'muted'}>
          {name}/
        </Mono>
        <Mono size={14} tone="muted">
          nextskin.mjs cli/ server/
        </Mono>
        <div style={{ marginTop: 8 }}>{status}</div>
      </Panel>
    </div>
  )
}

/** 下载中的新版本：还在 .staging 里，进度条按格走满 */
function Staging() {
  const t = useT()
  const p = steps(t, PREPARE + SIXTEENTH, prepare[0]!.done - PREPARE - SIXTEENTH, 8)
  const verified = t >= prepare[1]!.done
  return (
    <div
      className="border border-dashed border-border"
      style={abs(BOX.x, BOX.y[1], { width: BOX.w, height: BOX.h, padding: '10px 16px' })}
    >
      <Mono size={15} tone="muted">
        .staging/nextskin-{NEW}.zip
      </Mono>
      <div className="flex" style={{ gap: 4, marginTop: 10 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className={i < p * 8 ? 'bg-accent' : 'bg-surface-sunken'}
            style={{ width: (BOX.w - 32 - 7 * 4) / 8, height: 12 }}
          />
        ))}
      </div>
      {verified && (
        <div className="flex items-center" style={{ gap: 8, marginTop: 12 }}>
          <Mark ok cell={2} />
          <Px size={12} tone="success">
            签名和 SHA-256 都对得上
          </Px>
        </div>
      )}
    </div>
  )
}

function State({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'success' }) {
  return (
    <Px size={12} tone={tone}>
      {children}
    </Px>
  )
}

function Running() {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <Mark ok cell={2} />
      <State tone="success">运行中 · RUNNING</State>
    </div>
  )
}

/** 站点在线的格子：按时间一格一格亮起来，停站的那几格是红的 */
function Uptime({ t, down }: { t: number; down: boolean }) {
  const x0 = 176
  const pitch = (1216 - x0 + 4) / CELLS
  const part = (from: number, to: number, n: number) => Math.max(0, Math.min(1, (t - from) / (to - from))) * n
  const lit = Math.floor(part(PREPARE, DOWN, BEFORE) + part(DOWN, UP, OFFLINE) + part(UP, END, AFTER))
  const offline = (i: number) => i >= BEFORE && i < BEFORE + OFFLINE
  return (
    <>
      <div className="flex items-center" style={abs(64, 614, { height: 24 })}>
        <Px size={12} tone={down ? 'danger' : 'muted'}>
          站点 SITE
        </Px>
      </div>
      {Array.from({ length: CELLS }, (_, i) => (
        <div
          key={i}
          className={i >= lit ? 'border border-border' : offline(i) ? 'bg-danger' : 'bg-success'}
          style={abs(x0 + i * pitch, 614, { width: pitch - 4, height: 24 })}
        />
      ))}
      <Px size={12} tone="muted" style={abs(x0, 644)}>
        准备时照常运行
      </Px>
      <Px
        size={12}
        tone="danger"
        style={abs(x0 + BEFORE * pitch, 644, { visibility: lit > BEFORE ? 'visible' : 'hidden' })}
      >
        停站 1–3 秒（实测，没有迁移）
      </Px>
    </>
  )
}

/** 点按钮的鼠标：from 时出现，press 时按下，再过一个八分音符消失 */
function Cursor({ t, x, y, from, press }: { t: number; x: number; y: number; from: number; press: number }) {
  if (t < from || t >= press + 2 * EIGHTH) return null
  const down = t >= press && t < press + EIGHTH
  return (
    <div style={abs(x + (down ? 2 : 0), y + (down ? 2 : 0))}>
      <div className="absolute">
        <PixelIcon rows={cursor.fill} cell={2} tone="inverse" />
      </div>
      <PixelIcon rows={cursor.edge} cell={2} tone="text" />
    </div>
  )
}

export const upgrade: Page = {
  id: 'upgrade',
  Scene: Upgrade,
  duration: END + SIXTEENTH,
  hold: 4,
  chapter: { no: '01', zh: '部署', en: 'DEPLOY' },
  text: {
    title: '一键升级，准备好了才停站',
    en: "One-click upgrades. The site stays up until it's ready.",
    body: [
      '发行包能在后台一键升级。点“准备升级”时站点照常运行：下载 ZIP、核对 ed25519 签名和 SHA-256、解压到 `releases/<版本>/`，再用新版本对着在用的数据库预检。点“升级”以后才停掉旧版本、执行迁移、把 `current.json` 指向新版本、等它的 `/api/health` 返回 200；没有迁移时站点只停几秒。',
      '新版本没通过健康检查时自动换回旧版本，SQLite 连同迁移前的备份一起换回；MySQL、PostgreSQL 有迁移时要先确认已经备份。上一个版本留在 `releases/` 里，可以回到它。Docker 镜像只提示新版本，换标签升级。',
    ],
  },
}
