'use client'

import { RAISE_FRAMES } from '@nextskin/skin'
import { useEffect, useRef, useState } from 'react'
import { cx } from '../cx.ts'

interface Source {
  src: string
  srcSet?: string
}

export interface PoseFramesProps {
  /** 静止图：首屏就有，服务端渲染 */
  still: Source
  /** 抬手拼图：RAISE_FRAMES 帧从左到右排开，第一次悬浮或聚焦时才下载 */
  sprite: Source
  alt: string
  /** 一帧的 CSS 尺寸，和它相对人物方框的位置 */
  width: number
  height: number
  left: number
  top: number
  loading: 'lazy' | 'eager'
}

const image = 'absolute top-0 left-0 block max-w-none [image-rendering:pixelated]'
// 抬手分四格（DESIGN.md §2.2）：拼图向左挪四帧。只在拼图下载好以后（data-ready）才挪，第一次悬浮也从站立开始播。
// 过渡的是整数帧号 --raise-frame（theme.css），不直接过渡位移：位移的过渡被打断后，从半路接着分四格走，会停在两帧之间
const raise = cx(
  '[translate:calc(var(--raise-frame)*-20%)_0] [transition-property:--raise-frame] duration-slow ease-step',
  'motion-safe:group-hover/raise:data-ready:[--raise-frame:4]',
  'motion-safe:group-focus-visible/raise:data-ready:[--raise-frame:4]',
)

/**
 * SkinFigure 里的人物：平时只有静止图。祖先元素带 `group/raise` 时，鼠标第一次移上去或键盘聚焦它，才去下载抬手拼图，
 * 下载好就换成拼图，之后悬浮时播放抬手。列表页一屏几十张卡片，只有碰过的才多下载一张图（ADR-0048）。
 * 触屏不下载；开启"减少动态效果"时也不下载、不播放
 */
export function PoseFrames({ still, sprite, alt, width, height, left, top, loading }: PoseFramesProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'ready'>('idle')

  useEffect(() => {
    if (state !== 'idle') return
    const triggers: Element[] = []
    for (let node = ref.current?.closest('.group\\/raise'); node; node = node.parentElement?.closest('.group\\/raise'))
      triggers.push(node)
    if (triggers.length === 0) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    function start(event?: Event) {
      if (reduced.matches || (event instanceof PointerEvent && event.pointerType === 'touch')) return
      setState('loading')
    }
    // 水合之前鼠标就停在卡片上、或者已经聚焦了它，就收不到这两个事件
    if (triggers.some((trigger) => trigger.matches(':hover, :focus-visible'))) start()
    for (const trigger of triggers) {
      trigger.addEventListener('pointerenter', start)
      trigger.addEventListener('focusin', start)
    }
    return () => {
      for (const trigger of triggers) {
        trigger.removeEventListener('pointerenter', start)
        trigger.removeEventListener('focusin', start)
      }
    }
  }, [state])

  const ready = state === 'ready'
  return (
    <span ref={ref} className="absolute overflow-hidden" style={{ left, top, width, height }}>
      {/* 换成拼图以后静止图只是透明，替代文字还在 */}
      <img
        {...still}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        draggable={false}
        className={cx(image, ready && 'opacity-0')}
        style={{ width, height }}
      />
      {state !== 'idle' && (
        <img
          {...sprite}
          alt=""
          aria-hidden
          width={width * RAISE_FRAMES}
          height={height}
          decoding="async"
          draggable={false}
          data-raise
          data-ready={ready || undefined}
          // load 只说明下载完了。decoding="async" 的大图第一次露面时，浏览器可能先画一帧没有它的画面（高分屏上拼图解码后有两三 MB），
          // 这时静止图已经透明，人物消失一帧、露出展台底色，看着像闪白。解码好再换；解码失败也照换，load 成功说明图本身没坏
          onLoad={(event) => {
            const show = () => setState('ready')
            event.currentTarget.decode().then(show, show)
          }}
          className={cx(image, raise, !ready && 'opacity-0')}
          style={{ width: width * RAISE_FRAMES, height }}
        />
      )}
    </span>
  )
}
