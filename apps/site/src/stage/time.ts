import { createContext, useContext, type CSSProperties } from 'react'

// 场景的时间单位沿用介绍视频的节拍网格（126 BPM），只当刻度用，网站上没有配乐（ADR-0055）

export const BEAT = 60 / 126
export const BAR = BEAT * 4
export const EIGHTH = BEAT / 2
export const SIXTEENTH = BEAT / 4

/**
 * 场景里的时刻按视频的小节号写：`const at = barsFrom(25)` 以后，`at(25)` 是这一页的开头，
 * `at(26, 3)` 是第 26 小节第 3 拍。小节和拍都从 1 数，可以带小数
 */
export const barsFrom =
  (origin: number) =>
  (bar: number, beat = 1) =>
    ((bar - origin) * 4 + (beat - 1)) * BEAT

/** 当前这一页播到第几秒；静帧和看过的页给的是这一页的总长 */
export const TimeContext = createContext(0)
export const useT = () => useContext(TimeContext)

/** 画面上一个排版像素对应几个设备像素：出图按它选清晰度（ADR-0055） */
export const DensityContext = createContext(1)
export const useDensity = () => useContext(DensityContext)

/** 从 start 起 duration 秒内，分 n 格从 0 走到 1（CSS 的 steps(n, end)）。DESIGN.md 的动效都是阶跃的 */
export function steps(t: number, start: number, duration: number, n = 4) {
  if (t < start) return 0
  if (t >= start + duration) return 1
  return Math.floor(((t - start) / duration) * n) / n
}

/** 同上，但起点那一刻就走出第一格（steps(n, start)），进场时第一帧就看得见 */
export function stepsStart(t: number, start: number, duration: number, n = 4) {
  if (t < start) return 0
  return Math.min(1, (Math.floor(((t - start) / duration) * n) + 1) / n)
}

/** 进场：在 start 那一刻，四格之内从下方 dy 像素升到原位 */
export function enter(t: number, start: number, dy = 16, duration = SIXTEENTH): CSSProperties {
  if (t < start) return { visibility: 'hidden' }
  const p = stepsStart(t, start, duration)
  return { transform: `translateY(${Math.round((1 - p) * dy)}px)` }
}

/** 转身的进度：0 是正面，1 是背面。DESIGN.md 的转身是两段各四格 */
export function turn(t: number, start: number, duration = EIGHTH) {
  return steps(t, start, duration, 8)
}

/** 确定性的伪随机，同一个种子每次结果一样 */
export function random(seed: number) {
  let x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  x -= Math.floor(x)
  return x
}

/** 播放器里是 true；静帧（手机、减少动态效果、构建时的 HTML）是 false，3D 预览这类要跑脚本的东西换成图 */
export const LiveContext = createContext(false)
export const useLive = () => useContext(LiveContext)

/** 播放器暂停时是 false：3D 预览这类自己走的动画也要停下（WCAG 2.2.2） */
export const PlayingContext = createContext(true)
export const usePlaying = () => useContext(PlayingContext)
