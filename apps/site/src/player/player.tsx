import { cx, IconButton } from '@nextskin/ui'
import { Pause } from 'pixelarticons/react/Pause.js'
import { Play } from 'pixelarticons/react/Play.js'
import { type CSSProperties, useEffect, useReducer, useRef, useState } from 'react'
import type { Page } from '../scenes/page.ts'
import { pages } from '../scenes/pages.ts'
import { Frame, FRAME } from '../stage/frame.tsx'
import { PlayingContext } from '../stage/time.ts'
import { Px } from '../stage/ui.tsx'
import { PageBody } from '../text.tsx'

// 翻页的规则见 ADR-0055

/** 蓄满一次要滚的距离（像素）：鼠标滚轮三四格 */
const CHARGE_PX = 360
/** 停手多久以后开始回落（毫秒） */
const IDLE = 160
/** 回落的速度：每秒回落多少格 */
const DECAY = 1.5
/** 翻页以后，滚轮事件之间空出这么久（毫秒）才算新的一次滑动；之前的都当惯性丢掉 */
const QUIET = 220
/** 推页的每一格（毫秒），分 4 格推上来 */
const PUSH_STEP = 70
const PUSH_STEPS = 4
const SEGMENTS = 20
const GUTTER = 24
const BAR = 64

const LAST = pages.length - 1

interface Engine {
  index: number
  t: number
  /** 这一页播完以后会不会自动翻：没看过、有停留时间、不是尾页 */
  auto: boolean
  /** 停留的进度，0 到 1，满了自动翻 */
  wait: number
  /** 滚轮蓄的力：正的往后翻，负的往前翻 */
  boost: number
  lastWheel: number
  /** 翻页以后吞掉惯性，直到滚轮停顿一下 */
  wheelLocked: boolean
  push: { from: number; fromT: number; dir: 1 | -1; start: number } | null
  seen: Set<number>
  paused: boolean
}

const autoAt = (index: number, seen: Set<number>) =>
  index < LAST && pages[index]!.hold !== undefined && !seen.has(index)

/**
 * 画面的缩放：铺满可用的区域。整数倍和铺满只差不到一成时用整数倍，一个排版像素正好是整数个设备像素，
 * 像素字体和出图最锐利（ADR-0055）
 */
function fit(width: number, height: number, dpr: number) {
  const f = Math.min(width / FRAME.width, height / FRAME.height)
  const k = Math.floor(f * dpr)
  return k >= 1 && k >= 0.9 * f * dpr ? { scale: k / dpr, density: k } : { scale: f, density: f * dpr }
}

/** 对齐到设备像素，免得画面落在半个像素上发虚 */
const snap = (n: number, dpr: number) => Math.round(n * dpr) / dpr

export function Player() {
  const engine = useRef<Engine>({
    index: 0,
    t: 0,
    auto: false,
    wait: 0,
    boost: 0,
    lastWheel: 0,
    wheelLocked: false,
    push: null,
    seen: new Set(),
    paused: false,
  })
  const [, render] = useReducer((n: number) => n + 1, 0)
  const area = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<{ width: number; height: number; dpr: number }>({
    width: FRAME.width,
    height: FRAME.height,
    dpr: 1,
  })

  // 窗口大小和设备像素比
  useEffect(() => {
    const el = area.current!
    const update = () => setView({ width: el.clientWidth, height: el.clientHeight, dpr: window.devicePixelRatio || 1 })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    let dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDpr = () => {
      update()
      dprQuery.removeEventListener('change', onDpr)
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDpr)
    }
    dprQuery.addEventListener('change', onDpr)
    return () => {
      observer.disconnect()
      dprQuery.removeEventListener('change', onDpr)
    }
  }, [])

  // 首屏播完以后在空闲时预取 3D 预览的库（玩家页用），翻到那一页时就不用等
  useEffect(() => {
    const id = setTimeout(() => void import('skinview3d'), 4000)
    return () => clearTimeout(id)
  }, [])

  // 时钟、滚轮、键盘、锚点
  useEffect(() => {
    const s = engine.current

    const go = (to: number) => {
      to = Math.max(0, Math.min(LAST, to))
      if (to === s.index) return
      const now = performance.now()
      s.seen.add(s.index)
      s.push = { from: s.index, fromT: s.t, dir: to > s.index ? 1 : -1, start: now }
      s.index = to
      // 看过的页直接停在最后一帧
      s.t = s.seen.has(to) ? pages[to]!.duration : 0
      s.auto = autoAt(to, s.seen)
      s.wait = 0
      s.boost = 0
      s.wheelLocked = true
      const hash = to === 0 ? '' : `#${pages[to]!.id}`
      if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`)
    }

    const fromHash = () => pages.findIndex((p) => `#${p.id}` === location.hash)
    const initial = fromHash()
    if (initial > 0) s.index = initial
    s.auto = autoAt(s.index, s.seen)

    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      // 切到别的标签页时浏览器不调度动画帧，回来以后时间从停下的地方接着走。
      // 动画帧的时间戳是这一帧开始的时刻，第一帧可能早于上面取的 last，不能让时间倒着走
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
      last = now
      const page = pages[s.index]!
      if (s.push && now - s.push.start >= PUSH_STEP * PUSH_STEPS) s.push = null
      if (!s.paused && !s.push) {
        if (s.t < page.duration) s.t = Math.min(page.duration, s.t + dt)
        else if (s.auto) s.wait = Math.min(1, s.wait + dt / page.hold!)
      }
      if (s.boost !== 0 && now - s.lastWheel > IDLE) {
        s.boost = Math.sign(s.boost) * Math.max(0, Math.abs(s.boost) - DECAY * dt)
      }
      if (!s.push) {
        if (s.wait + Math.max(0, s.boost) >= 1) go(s.index + 1)
        else if (s.boost <= -1) go(s.index - 1)
      }
      render()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const onWheel = (e: WheelEvent) => {
      // 按住 Ctrl 的滚轮和触控板的捏合是缩放，交给浏览器
      if (e.ctrlKey) return
      e.preventDefault()
      const now = performance.now()
      const gap = now - s.lastWheel
      s.lastWheel = now
      if (s.wheelLocked) {
        if (gap < QUIET || s.push) return
        s.wheelLocked = false
      }
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? FRAME.height : 1)
      if (dy === 0) return
      // 换方向从零开始蓄
      if (s.boost * dy < 0) s.boost = 0
      s.boost = Math.max(-1, Math.min(1, s.boost + dy / CHARGE_PX))
      if ((s.index === 0 && s.boost < 0) || (s.index === LAST && s.boost > 0)) s.boost = 0
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target instanceof Element ? e.target : null
      const onControl = target?.closest('a, button, input, select, textarea') != null
      switch (e.key) {
        case 'ArrowDown':
        case 'PageDown':
          go(s.index + 1)
          break
        case ' ':
          // 焦点在按钮和链接上时，空格是按下它
          if (onControl) return
          go(e.shiftKey ? s.index - 1 : s.index + 1)
          break
        case 'ArrowUp':
        case 'PageUp':
          go(s.index - 1)
          break
        case 'Home':
          go(0)
          break
        case 'End':
          go(LAST)
          break
        default:
          return
      }
      e.preventDefault()
    }

    const onHash = () => {
      const index = fromHash()
      go(index < 0 ? 0 : index)
    }

    const onNav = (e: Event) => go((e as CustomEvent<number>).detail)
    const onPause = () => {
      s.paused = !s.paused
    }

    addEventListener('wheel', onWheel, { passive: false })
    addEventListener('keydown', onKey)
    addEventListener('hashchange', onHash)
    addEventListener('player:go', onNav)
    addEventListener('player:pause', onPause)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('wheel', onWheel)
      removeEventListener('keydown', onKey)
      removeEventListener('hashchange', onHash)
      removeEventListener('player:go', onNav)
      removeEventListener('player:pause', onPause)
    }
  }, [])

  const s = engine.current
  const page = pages[s.index]!
  const avail = { width: view.width - 2 * GUTTER, height: view.height - GUTTER - BAR }
  const { scale, density } = fit(avail.width, avail.height, view.dpr)
  const width = snap(FRAME.width * scale, view.dpr)
  const height = snap(FRAME.height * scale, view.dpr)
  const left = snap((view.width - width) / 2, view.dpr)
  const top = snap(GUTTER + (avail.height - height) / 2, view.dpr)

  // 推页：分 4 格，新页从下方（往回翻时从上方）推上来，旧页被推出去
  const pushed = s.push
    ? Math.min(PUSH_STEPS, Math.floor((performance.now() - s.push.start) / PUSH_STEP) + 1) / PUSH_STEPS
    : 1
  const offset = (p: number) => snap(height * p, view.dpr)

  const forward = Math.min(1, s.wait + Math.max(0, s.boost))
  const back = Math.max(0, -s.boost)

  return (
    <PlayingContext value={!s.paused}>
      <div className="fixed inset-0 overflow-hidden bg-bg">
        <h1 className="sr-only">NextSkin</h1>
        <div ref={area} className="absolute inset-0">
          <div className="absolute overflow-hidden" style={{ left, top, width, height }}>
            {s.push && (
              <Layer
                page={pages[s.push.from]!}
                t={s.push.fromT}
                top={-s.push.dir * offset(pushed)}
                scale={scale}
                density={density}
                hidden
              />
            )}
            <Layer
              page={page}
              t={s.t}
              top={s.push ? s.push.dir * offset(1 - pushed) : 0}
              scale={scale}
              density={density}
            />
          </div>
        </div>
        <Controls
          index={s.index}
          seen={s.seen}
          forward={forward}
          back={back}
          waiting={s.auto && s.t >= page.duration}
          paused={s.paused}
          style={{ left, width, top: top + height }}
        />
        <section className="sr-only" aria-live="polite" aria-atomic>
          <h2>{page.text.title}</h2>
          <p lang="en">{page.text.en}</p>
          <PageBody page={page} />
        </section>
      </div>
    </PlayingContext>
  )
}

function Layer({
  page,
  t,
  top,
  scale,
  density,
  hidden = false,
}: {
  page: Page
  t: number
  top: number
  scale: number
  density: number
  hidden?: boolean
}) {
  return (
    <div
      aria-hidden={hidden || undefined}
      inert={hidden || undefined}
      className="absolute left-0 origin-top-left"
      style={{ top, transform: `scale(${scale})` }}
    >
      <Frame page={page} t={t} density={density} live />
    </div>
  )
}

const send = (name: string, detail?: number) => dispatchEvent(new CustomEvent(name, { detail }))

/** 画面下方的一条：页码方块、蓄力条、暂停 */
function Controls({
  index,
  seen,
  forward,
  back,
  waiting,
  paused,
  style,
}: {
  index: number
  seen: Set<number>
  forward: number
  back: number
  waiting: boolean
  paused: boolean
  style: CSSProperties
}) {
  const charging = back > 0 ? back : forward
  const filled = Math.floor(charging * SEGMENTS + 1e-9)
  const hint =
    back > 0
      ? '↑ 上一页 PREVIOUS'
      : index === LAST
        ? '最后一页 · 按 Home 回到开头'
        : waiting && !paused
          ? '自动翻页 · 滚动可以加快'
          : '滚动或按 ↓ 翻页 · SCROLL'
  return (
    <div className="absolute flex items-center" style={{ ...style, height: BAR, gap: 24 }}>
      <nav aria-label="页" className="flex items-center" style={{ gap: 2 }}>
        {pages.map((p, i) => (
          <button
            key={p.id}
            type="button"
            title={p.text.title}
            aria-label={`第 ${i + 1} 页：${p.text.title}`}
            aria-current={i === index ? 'step' : undefined}
            onClick={() => send('player:go', i)}
            className="group grid cursor-pointer place-items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            style={{ width: 18, height: 28 }}
          >
            <span
              className={cx(
                'block group-hover:border-accent',
                i === index ? 'bg-accent' : seen.has(i) ? 'bg-text-muted' : 'border border-border-strong',
              )}
              style={{ width: 10, height: i === index ? 16 : 10 }}
            />
          </button>
        ))}
      </nav>
      <div className="flex flex-1 items-center justify-end" style={{ gap: 12 }} aria-hidden>
        <Px size={12} tone="muted">
          {hint}
        </Px>
        <div className="flex" style={{ gap: 2 }}>
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span
              key={i}
              className={cx('block', i < filled ? (back > 0 ? 'bg-text-muted' : 'bg-accent') : 'bg-border')}
              style={{ width: 6, height: 12 }}
            />
          ))}
        </div>
        <Px size={12} tone="muted" className="tabular-nums">
          {String(index + 1).padStart(2, '0')} / {pages.length}
        </Px>
      </div>
      <IconButton label={paused ? '继续播放' : '暂停自动播放'} size="sm" onClick={() => send('player:pause')}>
        {paused ? <Play /> : <Pause />}
      </IconButton>
    </div>
  )
}
