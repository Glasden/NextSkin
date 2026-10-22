import type { ComponentType } from 'react'

export interface Chapter {
  no: string
  zh: string
  en: string
}

/** 第 7 页依次换上的主题（DESIGN.md 附录），取值在 site.css */
export type Palette = 'cobalt' | 'magenta' | 'contrast'

/** 一页：一个场景加上它的文字（ADR-0055） */
export interface Page {
  /** 锚点 */
  id: string
  Scene: ComponentType
  /** 动画播完的时刻（秒）。静帧和看过的页停在这一刻 */
  duration: number
  /** 播完以后停多久再自动翻页（秒），按画面上的文字量定；不给就不自动翻 */
  hold?: number
  /** 角落的章节号；首屏、分界页、尾页没有 */
  chapter?: Chapter
  /** 整页换主题：按这一页的时刻给出主题，undefined 是默认的钻石青 */
  palette?: (t: number) => Palette | undefined
  /** 手机和读屏的文字：标题、英文副标题、正文的几段 */
  text: { title: string; en: string; body: readonly string[] }
}
