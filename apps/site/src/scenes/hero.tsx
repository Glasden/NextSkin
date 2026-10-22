import { cx, focusRing } from '@nextskin/ui'
import { ArrowDown } from 'pixelarticons/react/ArrowDown.js'
import type { CSSProperties } from 'react'
import { LOGO_CELLS, LogoCells } from '../stage/skin.tsx'
import { BEAT, EIGHTH, enter, random, SIXTEENTH, steps, useLive, usePlaying, useT } from '../stage/time.ts'
import { Chip, Px } from '../stage/ui.tsx'
import { Entries } from './entries.tsx'
import type { Page } from './page.ts'

// 打乱的出现顺序：每个格子一个随机数，按大小排名
const order = Array.from({ length: LOGO_CELLS }, (_, i) => i)
  .sort((a, b) => random(a + 7) - random(b + 7))
  .reduce<number[]>((rank, cell, i) => {
    rank[cell] = i
    return rank
  }, [])

// 首屏是网站的门面，入口不能让人等：两秒半以内全部出齐，比视频里的快一倍
const REVEAL = 2 * BEAT
const TAGLINE = 2.5 * BEAT
const CHIPS = 3 * BEAT
const REWRITE = 4 * BEAT
const ENTRIES = 5 * BEAT
const ARROW = 6 * BEAT
const NAME = 'NextSkin'
const stack = ['TypeScript', 'Next.js', 'Hono', 'Kysely']

/** 首屏：标志的格子一批一批亮起，打出站名，再出定位、技术栈和三个入口 */
function Hero() {
  const t = useT()
  const live = useLive()
  const shown = Math.min(
    LOGO_CELLS,
    Math.ceil((Math.floor(t / SIXTEENTH) * LOGO_CELLS) / Math.round(REVEAL / SIXTEENTH)),
  )
  const typed = t < REVEAL ? 0 : Math.min(NAME.length, (Math.floor((t - REVEAL) / SIXTEENTH) + 1) * 2)
  return (
    <>
      <div className="grid-lines absolute inset-0" style={{ opacity: steps(t, 0, REVEAL, 8) * 0.9 }} />
      {/* 播放器里下边空出来给箭头 */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
        style={{ paddingBottom: live ? 56 : 0 }}
      >
        <div className="flex items-center" style={{ gap: 40 }}>
          <LogoCells cell={16} order={order} visible={(rank) => (rank < shown ? 1 : 0)} />
          <Px size={120}>
            {NAME.slice(0, typed)}
            <span className="invisible">{NAME.slice(typed)}</span>
          </Px>
        </div>
        <div style={{ marginTop: 36, textAlign: 'center', ...enter(t, TAGLINE) }}>
          <Px size={36}>Minecraft 皮肤站与外置登录</Px>
          <Px size={24} tone="muted" style={{ marginTop: 8 }}>
            Skin hosting &amp; Yggdrasil auth for Minecraft
          </Px>
        </div>
        <div className="flex" style={{ gap: 16, marginTop: 32, height: 52 }}>
          {stack.map((name, i) => (
            <div key={name} style={enter(t, CHIPS + i * EIGHTH)}>
              <Chip shadow={2}>{name}</Chip>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 24, textAlign: 'center', ...enter(t, REWRITE) }}>
          <Px size={24}>Blessing Skin 的 TypeScript 全栈重写</Px>
          <Px size={24} tone="muted">
            A full-stack TypeScript rewrite of Blessing Skin Server
          </Px>
        </div>
        <Entries style={{ marginTop: 40, ...enter(t, ENTRIES) }} />
      </div>
      <ScrollCue style={enter(t, ARROW, 0)} />
    </>
  )
}

/**
 * 引导往下翻的箭头，点了也翻页。首屏不自动翻，画面播完就停在最后一帧，所以跳动用 CSS 的循环动画，不跟这一页的时钟；
 * 暂停时一起停。静帧（手机上本来就是往下滚的长页面）里不画
 */
function ScrollCue({ style }: { style: CSSProperties }) {
  const live = useLive()
  const playing = usePlaying()
  if (!live) return null
  return (
    <div className="absolute inset-x-0 flex justify-center" style={{ bottom: 16, ...style }}>
      <button
        type="button"
        aria-label="下一页"
        title="下一页"
        onClick={() => dispatchEvent(new CustomEvent('player:go', { detail: 1 }))}
        className={cx('grid cursor-pointer place-items-center text-text-muted hover:text-accent', focusRing)}
        style={{ width: 72, height: 72 }}
      >
        <ArrowDown
          aria-hidden
          width={48}
          height={48}
          className="animate-nudge"
          style={{ animationPlayState: playing ? 'running' : 'paused' }}
        />
      </button>
    </div>
  )
}

export const hero: Page = {
  id: 'top',
  Scene: Hero,
  duration: ARROW + SIXTEENTH,
  text: {
    title: 'NextSkin',
    en: 'Skin hosting & Yggdrasil auth for Minecraft',
    body: [
      'Minecraft 皮肤站与外置登录。NextSkin 是 Blessing Skin Server 的 TypeScript 全栈重写：Next.js 做页面，Hono 做协议端点和 API，Kysely 连数据库。',
      '和 Blessing Skin 用同一套协议，玩家的模组和启动器不用升级；旧站可以一键迁过来。',
    ],
  },
}
