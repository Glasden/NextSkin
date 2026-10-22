import { cx } from '@nextskin/ui'
import { barsFrom, EIGHTH, enter, SIXTEENTH, steps, useT } from '../stage/time.ts'
import { abs, Mark, Mono, Panel, Pill, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(37)

// 一次注册（packages/domain 的注册用例）：写用户、用 adjustScore 加初始积分并记流水，
// 再把 user.registered 按订阅者展开成任务。两个订阅者是官方插件 invitation-codes 和 share-registration-link
const lines = [
  { at: at(37), sql: 'insert into users …', note: '' },
  { at: at(37, 1.5), sql: 'update users set score = score + ? where id = ?', note: 'adjustScore' },
  { at: at(37, 2), sql: 'insert into score_transactions …', note: '' },
  { at: at(37, 2.5), sql: 'insert into jobs  plugin:invitation-codes:on:user.registered', note: '', job: true },
  { at: at(37, 3), sql: 'insert into jobs  plugin:share-registration-link:on:user.registered', note: '', job: true },
]

const JOBS = [
  { id: 41, name: 'plugin:invitation-codes:on:…' },
  { id: 42, name: 'plugin:share-registration-…' },
]

const TX = { x: 64, y: 214, w: 740, h: 212 }
const TABLE = { x: 836, y: 214, w: 380 }
const COMMIT = at(37, 4)
const RACE = at(38)
const CLAIMED = at(38, 2)
const DONE = at(38, 4)
const COLS = '44px 1fr 72px'

/**
 * 事件在业务事务里按订阅者展开成任务，和业务写入一起提交（ADR-0021）；
 * 两个实例抢同一个任务，带条件的 UPDATE 只让一个认领成功，失败的按退避重试、用完次数进死信
 */
function Jobs() {
  const t = useT()
  const committed = t >= COMMIT
  const drop = steps(t, COMMIT, SIXTEENTH, 4)
  const claimed = t >= CLAIMED
  // 两个实例同时发出 UPDATE：认领之前的进度条
  const race = steps(t, RACE, CLAIMED - RACE, 8)

  return (
    <Scene>
      <Title zh="事件和业务写入，同一个事务提交" en="Events commit together with the data" />
      <div style={abs(TX.x, TX.y)}>
        <Panel
          bg="sunken"
          shadow={committed ? 4 : 0}
          edge={committed ? 'success' : 'border'}
          thick={committed}
          style={{ width: TX.w, height: TX.h, padding: '14px 20px' }}
        >
          <Mono size={15} tone="accent">
            BEGIN
            <span className="text-text-muted"> -- 注册一个用户</span>
          </Mono>
          {lines.map((l) => (
            <Mono
              key={l.sql}
              size={15}
              tone={l.job ? 'text' : 'muted'}
              style={{ paddingLeft: 20, ...enter(t, l.at, 0) }}
            >
              {l.job ? (
                <>
                  insert into <span className="text-accent">jobs</span>
                  {l.sql.slice('insert into jobs'.length)}
                </>
              ) : (
                l.sql
              )}
              {l.note && <span className="text-accent">{`  -- ${l.note}`}</span>}
            </Mono>
          ))}
          <Mono size={15} tone={committed ? 'success' : 'muted'} style={{ marginTop: 4 }}>
            {committed ? 'COMMIT' : ' '}
          </Mono>
        </Panel>
        <Px size={12} tone="muted" style={{ marginTop: 8 }}>
          任务表本身就是 outbox：提交了才看得见，回滚就一起消失
        </Px>
      </div>

      <div style={abs(TABLE.x, TABLE.y, { width: TABLE.w })}>
        <Mono size={15} tone="muted">
          jobs
        </Mono>
        <div className="grid border-b border-border" style={{ gridTemplateColumns: COLS, gap: 10, padding: '6px 0' }}>
          {['id', 'name', 'attempts'].map((h) => (
            <Mono key={h} size={13} tone="muted">
              {h}
            </Mono>
          ))}
        </div>
        {committed &&
          JOBS.map((job, i) => {
            const winner = i === 1 && claimed
            return (
              <div
                key={job.id}
                className={cx('grid border-b border-border', winner && 'bg-accent-subtle')}
                style={{
                  gridTemplateColumns: COLS,
                  gap: 10,
                  padding: '8px 0',
                  transform: `translateY(${Math.round((1 - drop) * -24)}px)`,
                }}
              >
                <Mono size={14}>{job.id}</Mono>
                <Mono size={14} className="overflow-hidden">
                  {job.name}
                </Mono>
                <Mono size={14} tone={winner ? 'accent' : 'text'}>
                  {winner ? 1 : 0}
                </Mono>
              </div>
            )
          })}
      </div>

      {/* 两个实例同时认领 42 号 */}
      <div style={abs(64, 474, { width: 1152, ...enter(t, RACE) })}>
        <Mono size={15}>
          <span className="text-accent">update</span> jobs set run_at = ?, lease_id = ?, attempts = attempts + 1{' '}
          <span className="text-accent">where</span> id = 42 <span className="text-accent">and run_at {'<='} ?</span>
        </Mono>
        <div className="flex" style={{ gap: 24, marginTop: 14 }}>
          {[
            { name: '实例 A', ok: true, result: '1 行 → 认领成功' },
            { name: '实例 B', ok: false, result: '0 行 → 别人拿走了' },
          ].map((r) => (
            <Panel
              key={r.name}
              shadow={claimed && r.ok ? 4 : 0}
              edge={claimed && r.ok ? 'accent' : 'border'}
              thick={claimed && r.ok}
              style={{ width: 300, height: 96, padding: '12px 16px' }}
            >
              <div className="flex items-center" style={{ gap: 12 }}>
                <Px size={24}>{r.name}</Px>
                {!claimed && <div className="bg-accent" style={{ width: Math.round(12 + race * 120), height: 8 }} />}
              </div>
              {claimed && (
                <div className="flex items-center" style={{ gap: 10, marginTop: 6 }}>
                  <Mark ok={r.ok} cell={2} />
                  <Px size={24} tone={r.ok ? 'text' : 'muted'}>
                    {r.result}
                  </Px>
                </div>
              )}
            </Panel>
          ))}
          <div className="flex flex-1 flex-col" style={{ gap: 10 }}>
            <div className="flex items-center" style={{ gap: 10, ...enter(t, at(38, 3)) }}>
              <Pill tone="warning" size={12}>
                失败
              </Pill>
              <Mono size={14}>10s → 20s → 40s → … ≤ 1h</Mono>
            </div>
            <div className="flex items-center" style={{ gap: 10, ...enter(t, at(38, 3) + EIGHTH) }}>
              <Pill tone="danger" size={12}>
                5 次用完
              </Pill>
              <Mono size={14}>→ failed_jobs，后台可以重试</Mono>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 18, ...enter(t, DONE) }}>
          <Px size={24}>四种数据库同一套认领：不靠 SKIP LOCKED、LISTEN/NOTIFY，也不要 Redis</Px>
        </div>
      </div>
    </Scene>
  )
}

export const jobs: Page = {
  id: 'jobs',
  Scene: Jobs,
  duration: DONE + SIXTEENTH,
  hold: 6,
  chapter: { no: '10', zh: '任务', en: 'JOBS' },
  text: {
    title: '事件和业务写入，同一个事务提交',
    en: 'Events commit together with the data',
    body: [
      '注册一个用户时，写用户、加初始积分、记积分流水，再把 `user.registered` 事件按订阅它的插件展开成任务，全部在同一个事务里。任务表本身就是 outbox：提交了才看得见，回滚就一起消失。',
      '几个实例同时认领同一个任务时，带条件的 UPDATE 只让一个成功。失败的任务按 10 秒起翻倍的间隔重试，最长 1 小时；5 次用完进死信表，后台可以重试。四种数据库同一套做法，不靠 `SKIP LOCKED`、`LISTEN/NOTIFY`，也不要 Redis。',
    ],
  },
}
