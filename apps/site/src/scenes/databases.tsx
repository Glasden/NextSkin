import repoData from '../gen/repo-data.json'
import { BAR, barsFrom, enter, random, SIXTEENTH, useT } from '../stage/time.ts'
import { abs, Mono, Panel, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(14)

// 从地面往上：默认的 SQLite 在最底下
const tower = [
  { name: 'SQLite', note: '默认 · node:sqlite', en: '1 writer + 1 reader · WAL' },
  { name: 'MySQL', note: '', en: '' },
  { name: 'MariaDB', note: '', en: '' },
  { name: 'PostgreSQL', note: '', en: '' },
] as const

const { upsert } = repoData

// 每一层亮的时候，左边换成这一种数据库上 upsert 实际发出的语句（scripts/queries.ts 用 Kysely 的编译器算出来）
const statements = [
  { sql: [upsert.sqlite], note: 'ON CONFLICT 一条语句完成' },
  {
    sql: [upsert.mysqlUpdate, `-- 0 行时\n${upsert.mysqlInsert}`],
    note: '先 UPDATE 拿排他锁，避开 InnoDB 共享锁升级的死锁',
  },
  { sql: [upsert.mysqlUpdate, `-- 0 行时\n${upsert.mysqlInsert}`], note: '自己开的事务遇到死锁就重试，最多 3 次' },
  { sql: [upsert.postgres], note: '出错会废掉整个事务，所以靠 ON CONFLICT 避开' },
]

/** SQL 在固定宽度里折行：按空格断开 */
function wrap(text: string, width: number) {
  return text.split('\n').flatMap((line) => {
    const out: string[] = []
    let cur = ''
    for (const word of line.split(' ')) {
      if (cur && `${cur} ${word}`.length > width) {
        out.push(cur)
        cur = `  ${word}`
      } else cur = cur ? `${cur} ${word}` : word
    }
    return [...out, cur]
  })
}

const stars = Array.from({ length: 14 }, (_, i) => ({
  x: Math.round((700 + random(i) * 520) / 4) * 4,
  y: Math.round((110 + random(i + 50) * 120) / 4) * 4,
  bright: i % 3 === 0,
}))

const H = 76
const BASE = 590

/** 四种数据库从地面摞到太空，一层一层亮；左边是这一层的数据库上 upsert 实际发出的语句 */
function Databases() {
  const t = useT()
  const lit = Math.max(0, Math.min(tower.length, Math.floor(t / BAR) + 1))
  const current = statements[lit - 1]!

  return (
    <Scene>
      <Title zh="四种数据库，一份代码" en="Four databases, one codebase" />
      <div style={abs(64, 214, { width: 640 })}>
        <Mono size={16} tone="muted">
          <span className="text-accent">upsert</span>(tx, &apos;settings&apos;, {'{'} conflict: [&apos;namespace&apos;,
          &apos;key&apos;], … {'}'})
        </Mono>
        <Panel bg="sunken" shadow={4} style={{ marginTop: 12, height: 236, padding: '16px 20px' }}>
          <Px size={12} tone="accent">
            {tower[lit - 1]!.name} 实际发出的语句
          </Px>
          <Mono size={15} style={{ marginTop: 8, lineHeight: 1.5 }}>
            {current.sql.flatMap((q) => wrap(q, 62)).join('\n')}
          </Mono>
        </Panel>
        <Px size={24} style={{ marginTop: 16 }}>
          {current.note}
        </Px>
      </div>
      <div className="flex" style={abs(64, 600, { width: 640, gap: 40, ...enter(t, at(17, 3)) })}>
        <div>
          <Px size={24}>每个数据库测试都在四种上跑</Px>
          <Px size={12} tone="muted">
            EVERY DB TEST RUNS ON ALL FOUR
          </Px>
        </div>
        <div>
          <Px size={24}>不需要 Redis</Px>
          <Px size={12} tone="muted">
            NO REDIS REQUIRED
          </Px>
        </div>
      </div>
      {stars.map((s, i) => (
        <div
          key={i}
          className="bg-text-muted"
          style={abs(s.x, s.y, { width: 4, height: 4, opacity: s.bright ? 1 : 0.3 })}
        />
      ))}
      {tower.map((d, i) => {
        const on = i < lit
        return (
          <div key={d.name} style={abs(760, BASE - (i + 1) * (H + 12), { width: 420 })}>
            <Panel
              shadow={on ? 4 : 2}
              bg={on ? 'accent-subtle' : 'surface'}
              edge={on ? 'accent' : 'border'}
              thick={on}
              className="flex items-center justify-between"
              style={{ height: H, padding: '0 20px' }}
            >
              <Px size={36}>{d.name}</Px>
              {d.note && (
                <div style={{ textAlign: 'right' }}>
                  <Px size={12}>{d.note}</Px>
                  <Px size={12} tone="muted">
                    {d.en}
                  </Px>
                </div>
              )}
            </Panel>
          </div>
        )
      })}
      {/* 地面：和领奖台一样，站在一条深色的线上 */}
      <div
        className="border-t-4 border-border-strong bg-surface-sunken"
        style={abs(720, BASE + 4, { width: 500, height: 12 })}
      />
    </Scene>
  )
}

export const databases: Page = {
  id: 'databases',
  Scene: Databases,
  duration: at(17, 3) + SIXTEENTH,
  hold: 4,
  chapter: { no: '03', zh: '数据库', en: 'DATABASES' },
  text: {
    title: '四种数据库，一份代码',
    en: 'Four databases, one codebase',
    body: [
      '默认用 Node 内置的 SQLite，什么都不用装；也支持 MySQL、MariaDB 和 PostgreSQL。每一个数据库测试都在四种上跑。',
      '同一个 upsert 在四种数据库上发出不同的语句：SQLite 和 PostgreSQL 用 ON CONFLICT；MySQL 和 MariaDB 先 UPDATE 拿排他锁、没有行再 INSERT，避开 InnoDB 共享锁升级的死锁。不需要 Redis。',
    ],
  },
}
