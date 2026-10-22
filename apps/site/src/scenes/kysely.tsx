import { cx } from '@nextskin/ui'
import repoData from '../gen/repo-data.json'
import { barsFrom, EIGHTH, enter, SIXTEENTH, steps, useT } from '../stage/time.ts'
import { abs, Mark, Mono, Panel, Pill, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(35)

const { plugin } = repoData
const TABLE = plugin.tree.findIndex((n) => n.kind === 'TableNode')
const physical = `p_${plugin.id.replaceAll('-', '_')}__codes`

// plugins/invitation-codes 的 user.register 拦截器（节选：略去了过期时间的条件）
const code = [
  "'user.register': async ({ input, ctx }) => {",
  '  const result = await ctx.db',
  "    .updateTable('codes')",
  "    .set({ status: 'used', … })",
  "    .where('code', '=', code)",
  "    .where('status', '=', 'unused')",
  '    .executeTakeFirst()',
  '  if (result.numUpdatedRows === 0n)',
  "    return deny('invalid_code', …)",
  '}',
]

const LEFT = { x: 64, w: 400 }
const WALL = 488
const TREE = { x: 520, w: 400 }
const RIGHT = { x: 944, w: 272 }
const ROW = 40
const TOP = 236
const REJECT = at(36, 4)

/**
 * 邀请码插件在 plugin host 里写查询，发给核心的只有 Kysely 的节点树。核心按白名单逐个节点重建，
 * 表名改写成物理名、用核心的编译器编译、在注册事务里执行；最后一条原始 SQL 被拒绝
 */
function Kysely() {
  const t = useT()
  const renamed = steps(t, at(36), EIGHTH, 4)
  const tableLabel = renamed === 0 ? 'codes' : physical.slice(0, Math.max(5, Math.round(physical.length * renamed)))

  return (
    <Scene>
      <Title zh="插件的查询，由核心重建" en="Plugin queries are rebuilt by the core" />
      <div style={abs(LEFT.x, TOP - 30)}>
        <Px size={12} tone="muted">
          PLUGIN HOST · plugins/invitation-codes（节选）
        </Px>
      </div>
      <div style={abs(LEFT.x, TOP)}>
        <Panel bg="sunken" shadow={0} style={{ width: LEFT.w, padding: '14px 16px' }}>
          {code.map((line, i) => (
            <Mono key={i} size={13} tone={i >= 2 && i <= 5 ? 'text' : 'muted'}>
              {line}
            </Mono>
          ))}
        </Panel>
        <Px size={12} tone="muted" style={{ marginTop: 10 }}>
          插件编译出的 SQL 字符串直接丢掉
        </Px>
      </div>

      {/* 进程的边界：只有节点树过得去 */}
      <div className="border-l-2 border-dashed border-border" style={abs(WALL, TOP - 30, { width: 0, height: 440 })} />
      <div style={abs(WALL - 50, TOP + 400, { width: 100, textAlign: 'center' })}>
        <Px size={12} tone="muted" className="bg-bg">
          RPC
        </Px>
      </div>

      <div style={abs(TREE.x, TOP - 30)}>
        <Px size={12} tone="muted">
          核心：按白名单逐个节点重建 · REBUILT, NOT CHECKED
        </Px>
      </div>
      {plugin.tree.map((node, i) => {
        const arriveAt = at(35) + i * EIGHTH
        if (t < arriveAt) return null
        // 节点从墙的另一边滑进来，四格
        const p = steps(t, arriveAt, SIXTEENTH, 4)
        const x = TREE.x + node.depth * 28 - (1 - p) * 120
        const lit = i === TABLE && renamed > 0
        return (
          <div key={i} className="flex items-center" style={abs(Math.round(x), TOP + i * ROW, { gap: 10 })}>
            <div
              className={cx(
                'flex items-baseline',
                lit ? 'border-2 border-accent bg-accent-subtle' : 'border border-border bg-surface',
              )}
              style={{ padding: '3px 10px', gap: 10 }}
            >
              <Mono size={13} tone="muted">
                {node.kind}
              </Mono>
              {node.value && (
                <Mono size={14} tone={lit ? 'accent' : 'text'}>
                  {i === TABLE ? tableLabel : node.value}
                </Mono>
              )}
            </div>
            {p === 1 && <Mark ok cell={2} />}
          </div>
        )
      })}
      {/* 最后：一条原始 SQL */}
      {t >= REJECT && (
        <div className="flex items-center" style={abs(TREE.x, TOP + plugin.tree.length * ROW + 24, { gap: 10 })}>
          <div className="flex border-2 border-danger bg-surface" style={{ padding: '3px 10px', gap: 10 }}>
            <Mono size={13} tone="muted">
              RawNode
            </Mono>
            <Mono size={14} tone="danger">
              drop table users
            </Mono>
          </div>
          <Mark ok={false} cell={3} />
        </div>
      )}

      <div style={abs(RIGHT.x, TOP, { width: RIGHT.w })}>
        <div style={enter(t, at(36, 2))}>
          <Px size={12} tone="muted">
            用核心自己的编译器重新编译
          </Px>
          <Panel bg="sunken" shadow={4} style={{ marginTop: 6, padding: '10px 12px' }}>
            <Mono size={13} style={{ whiteSpace: 'pre-wrap' }}>
              {plugin.sql}
            </Mono>
          </Panel>
        </div>
        <div style={{ marginTop: 16, ...enter(t, at(36, 3)) }}>
          <Px size={24}>在核心的注册事务里执行</Px>
          <Px size={12} tone="muted">
            0 行就拒绝这次注册
          </Px>
        </div>
        <div style={{ marginTop: 16, ...enter(t, REJECT) }}>
          <Pill tone="danger" size={12}>
            拒绝 REJECTED
          </Pill>
          <Mono size={13} tone="danger" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
            {plugin.raw}
          </Mono>
          <Mono size={13} tone="danger" style={{ whiteSpace: 'pre-wrap' }}>
            {plugin.foreign}
          </Mono>
        </div>
      </div>
    </Scene>
  )
}

export const kysely: Page = {
  id: 'queries',
  Scene: Kysely,
  duration: REJECT + SIXTEENTH,
  hold: 6,
  chapter: { no: '09', zh: '插件', en: 'PLUGINS' },
  text: {
    title: '插件的查询，由核心重建',
    en: 'Plugin queries are rebuilt by the core',
    body: [
      '插件也能用 Kysely 写自己的表，但 plugin host 发给核心的不是 SQL 字符串，而是 Kysely 的节点树。核心按白名单一个节点一个节点地重建，不是事后检查。',
      '重建时表名改写成这个插件独占的物理表名，再用核心自己的编译器编译、在核心的事务里执行。原始 SQL 节点、没有声明过的表（比如 `users`）一律拒绝。',
    ],
  },
}
