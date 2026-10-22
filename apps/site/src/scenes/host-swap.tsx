import { cx } from '@nextskin/ui'
import type { CSSProperties, ReactNode } from 'react'
import { BEAT, barsFrom, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { abs, icons, Mark, Mono, Panel, PixelIcon, Px, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(33)

const CORE = { x: 64, y: 236, w: 340, h: 300 }
const HOST = { x: 784, w: 432, h: 190 }
const GEN = [
  { no: 7, y: 220, plugins: 'whitelist-sync@1.0.0' },
  { no: 8, y: 430, plugins: 'whitelist-sync@1.1.0' },
]

const SWITCH = at(34)
const EXIT = at(34, 4)

/**
 * 安装的插件跑在 plugin host 进程里。升级插件时拉起新一代、加载并核对，然后原子切换，
 * 旧一代等在途的调用结束后整个进程退出（ADR-0009）
 */
function HostSwap() {
  const t = useT()
  const switched = t >= SWITCH
  const inflight = Math.max(0, 3 - Math.floor((t - SWITCH) / BEAT))
  const exited = t >= EXIT
  const active = switched ? 1 : 0
  // 请求的小方块：每拍从核心走到 host，八格
  const along = Math.min(7, Math.floor((((t % BEAT) + BEAT) % BEAT) / (BEAT / 8)))

  const wire = (gen: number) => {
    const y = GEN[gen]!.y + HOST.h / 2
    const on = gen === active
    const x0 = CORE.x + CORE.w
    const width = HOST.x - x0
    return (
      <div
        key={gen}
        className={cx(on ? 'bg-accent' : 'border-t-2 border-dashed border-border')}
        style={abs(x0, y - 2, { width, height: 4 })}
      >
        {on && <div className="bg-accent" style={abs((along * (width - 16)) / 7, -6, { width: 16, height: 16 })} />}
      </div>
    )
  }

  return (
    <Scene>
      <Title zh="插件热更新：整个进程换一代" en="Plugin hot reload replaces the whole process" />
      <div style={abs(CORE.x, CORE.y)}>
        <Panel shadow={4} className="flex flex-col" style={{ width: CORE.w, height: CORE.h, padding: '20px 24px' }}>
          <Px size={36}>核心进程</Px>
          <Px size={24} tone="muted">
            Core
          </Px>
          <Mono size={14} tone="muted" style={{ marginTop: 8 }}>
            Next.js · Hono · 领域层 · 数据库
          </Mono>
          <div style={{ marginTop: 'auto' }}>
            <Px size={12} tone="muted">
              插件注册表 REGISTRY
            </Px>
            <div
              className={cx('inline-block', switched ? 'bg-accent' : 'bg-surface-sunken')}
              style={{ marginTop: 6, padding: '2px 10px' }}
            >
              <Px size={24} tone={switched ? 'accent-fg' : 'text'}>
                → 第 {GEN[active]!.no} 代
              </Px>
            </div>
            <Px size={12} tone="accent" style={{ marginTop: 6, visibility: switched ? 'visible' : 'hidden' }}>
              原子切换 · ATOMIC SWITCH
            </Px>
          </div>
        </Panel>
      </div>
      {wire(0)}
      {t >= at(33, 2) && wire(1)}

      <Host y={GEN[0]!.y} title={`plugin host · 第 ${GEN[0]!.no} 代`} active={!switched} gone={exited}>
        <Mono size={14} tone="muted">
          {GEN[0]!.plugins}
        </Mono>
        {!switched && <Line ok text="在线，处理请求" />}
        {switched && !exited && <Line ok={false} pending text={`退役：等在途的调用结束 · ${inflight}`} />}
        {exited && (
          <Px size={24} tone="muted" style={{ marginTop: 10 }}>
            进程已退出 · EXITED
          </Px>
        )}
      </Host>

      {t < at(33, 2) ? (
        <div
          className="border border-dashed border-border"
          style={abs(HOST.x, GEN[1]!.y, { width: HOST.w, height: HOST.h })}
        />
      ) : (
        <Host y={GEN[1]!.y} title={`plugin host · 第 ${GEN[1]!.no} 代`} active={switched} style={enter(t, at(33, 2))}>
          <Mono size={13} tone="muted">
            node --permission --allow-fs-read=… host.mjs
          </Mono>
          <Mono size={13} tone="muted">
            env: {'{}'}
            {'  '}
            <span className="text-text">{GEN[1]!.plugins}</span>
          </Mono>
          <div style={enter(t, at(33, 3), 0)}>
            <Line ok text="加载插件，执行 setup" />
          </div>
          <div style={enter(t, at(33, 4), 0)}>
            <Line ok text="实际的定义和 manifest 一致" />
          </div>
        </Host>
      )}

      <div className="flex" style={abs(64, 576, { width: 660, gap: 16, ...enter(t, at(34, 2)) })}>
        <PixelIcon rows={icons.lock} cell={5} tone="accent" />
        <div>
          <Px size={24}>ESM 模块卸载不掉，那就让整个进程退出</Px>
          <Px size={12} tone="muted">
            ESM CAN&apos;T BE UNLOADED — SO THE WHOLE PROCESS EXITS · NO DB CREDENTIALS, EMPTY ENV
          </Px>
        </div>
      </div>
    </Scene>
  )
}

function Host({
  y,
  title,
  active,
  gone = false,
  style,
  children,
}: {
  y: number
  title: string
  active: boolean
  gone?: boolean
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div style={abs(HOST.x, y, style)}>
      <Panel
        shadow={active ? 4 : 0}
        bg={gone ? 'none' : 'surface'}
        edge={active ? 'accent' : 'border'}
        thick={active}
        dashed={gone}
        style={{ width: HOST.w, height: HOST.h, padding: '14px 20px', opacity: gone ? 0.6 : 1 }}
      >
        <Px size={24} tone={active ? 'text' : 'muted'} style={{ marginBottom: 6 }}>
          {title}
        </Px>
        {children}
      </Panel>
    </div>
  )
}

function Line({ ok, text, pending = false }: { ok: boolean; text: string; pending?: boolean }) {
  return (
    <div className="flex items-center" style={{ gap: 10, marginTop: 8 }}>
      {pending ? (
        <div className="border-2 border-warning" style={{ width: 18, height: 18 }} />
      ) : (
        <Mark ok={ok} cell={2} />
      )}
      <Px size={24} tone={pending ? 'warning' : 'text'}>
        {text}
      </Px>
    </div>
  )
}

export const hostSwap: Page = {
  id: 'plugins',
  Scene: HostSwap,
  duration: EXIT + SIXTEENTH,
  hold: 4,
  chapter: { no: '09', zh: '插件', en: 'PLUGINS' },
  text: {
    title: '插件热更新：整个进程换一代',
    en: 'Plugin hot reload replaces the whole process',
    body: [
      '安装的插件不跑在核心进程里，而是跑在核心拉起的 plugin host 进程里：带 Node 的权限模型启动，环境变量是空的，拿不到数据库凭据，只能通过 RPC 调用核心。',
      '升级插件时，核心拉起新一代 host、加载插件并核对实际的定义和 manifest 一致，再原子地把注册表切过去；旧一代等在途的调用结束后整个进程退出。ESM 模块卸载不掉，那就让整个进程退出。',
    ],
  },
}
