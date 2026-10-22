import { barsFrom, EIGHTH, enter, SIXTEENTH, steps, useT } from '../stage/time.ts'
import { abs, Mark, Mono, Panel, Prompt, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(3)

const COMMAND = 'node nextskin.mjs start'

// ADR-0008：原生依赖换成 Node 内置的 node:sqlite 和纯 TS 的 PNG 管线
const swaps = [
  { from: 'sharp', note: 'libvips · C', to: '纯 TS 的 PNG 管线', en: 'pure TS PNG pipeline', at: at(4) },
  { from: 'better-sqlite3', note: 'C++ 原生模块', to: 'node:sqlite', en: 'built into Node', at: at(4, 3) },
]

const platforms = ['linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']
const BOOT = at(5, 3)

/** 一条命令启动整个站点；两个原生依赖被划掉、换成内置的实现；六种平台依次启动，同一个 ZIP 包 */
function Deploy() {
  const t = useT()
  const typed = Math.min(COMMAND.length, Math.max(0, (Math.floor((t - at(3)) / SIXTEENTH) + 1) * 3))
  return (
    <Scene>
      <Title zh="一条命令，零原生依赖" en="One command. Zero native dependencies." />
      <div style={abs(64, 224, { width: 540 })}>
        <Prompt size={24} cursor={typed < COMMAND.length}>
          {COMMAND.slice(0, typed)}
        </Prompt>
        <div style={{ marginTop: 4, ...enter(t, at(3, 3)) }}>
          <Px size={24}>一条命令，整个站点</Px>
          <Px size={12} tone="muted">
            WEB PAGES, PROTOCOL ENDPOINTS, BACKGROUND JOBS, PLUGIN HOST
          </Px>
        </div>
        <div className="flex flex-col" style={{ gap: 24, marginTop: 36 }}>
          {swaps.map((s) => {
            const strike = steps(t, s.at, EIGHTH)
            return (
              <div key={s.from} style={enter(t, s.at)}>
                <div className="flex items-center" style={{ gap: 14 }}>
                  <Mark ok={false} />
                  <div className="relative">
                    <Mono size={26} tone="muted">
                      {s.from}
                    </Mono>
                    <div
                      className="bg-danger"
                      style={abs(-4, 19, { height: 4, width: `calc(${strike * 100}% + 8px)` })}
                    />
                  </div>
                  <Px size={12} tone="muted">
                    {s.note}
                  </Px>
                </div>
                <div
                  className="flex items-center"
                  style={{ gap: 14, marginTop: 8, marginLeft: 38, ...enter(t, s.at + 2 * EIGHTH) }}
                >
                  <Px size={24} tone="accent">
                    →
                  </Px>
                  <div>
                    <Px size={24}>{s.to}</Px>
                    <Px size={12} tone="muted">
                      {s.en}
                    </Px>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ marginTop: 28, ...enter(t, at(5, 2)) }}>
          <Px size={24}>发行包里没有一个 .node 文件</Px>
          <Px size={12} tone="muted">
            NOT A SINGLE .node FILE IN THE RELEASE
          </Px>
        </div>
      </div>
      <div className="grid" style={abs(640, 236, { gridTemplateColumns: 'repeat(3, 180px)', gap: 16 })}>
        {platforms.map((name, i) => {
          const boot = BOOT + i * EIGHTH
          const up = t >= boot
          const ready = t >= boot + EIGHTH
          return (
            <Panel
              key={name}
              shadow={up ? 2 : 0}
              bg={up ? 'sunken' : 'none'}
              edge={ready ? 'accent' : 'border'}
              thick={ready}
              dashed={!up}
              style={{ height: 100, padding: '12px 14px' }}
            >
              <Mono size={16} tone={up ? 'text' : 'muted'}>
                {name}
              </Mono>
              {up && (
                <div className="flex items-center" style={{ gap: 8, marginTop: 14 }}>
                  {ready ? <Mark ok cell={2} /> : <div style={{ width: 16 }} />}
                  <Mono size={13} tone={ready ? 'success' : 'muted'}>
                    {ready ? 'ready' : 'starting…'}
                  </Mono>
                </div>
              )}
            </Panel>
          )
        })}
      </div>
      <div style={abs(640, 488, { width: 572, ...enter(t, BOOT + 7 * EIGHTH) })}>
        <Panel bg="accent" edge="accent" shadow={4} style={{ padding: '10px 16px' }}>
          <Px size={24} tone="accent-fg">
            一个 ZIP，有 Node 26 就能跑
          </Px>
          <Px size={12} tone="accent-fg" style={{ opacity: 0.75 }}>
            ONE ZIP. ANY MACHINE WITH NODE 26.
          </Px>
        </Panel>
      </div>
    </Scene>
  )
}

export const deploy: Page = {
  id: 'deploy',
  Scene: Deploy,
  duration: BOOT + 7 * EIGHTH + SIXTEENTH,
  hold: 4,
  chapter: { no: '01', zh: '部署', en: 'DEPLOY' },
  text: {
    title: '一条命令，零原生依赖',
    en: 'One command. Zero native dependencies.',
    body: [
      '`node nextskin.mjs start` 启动整个站点：网页、协议端点、后台任务和插件进程都在里面，不用装 PHP，也不需要 Redis。',
      '图像处理换成纯 TypeScript 的 PNG 管线，数据库驱动用 Node 内置的 node:sqlite。发行包里没有一个原生模块，同一个 ZIP 在 Linux、Windows、macOS 的 x64 和 arm64 上都能直接跑：需要 Node 24 以上，推荐 26。',
    ],
  },
}
