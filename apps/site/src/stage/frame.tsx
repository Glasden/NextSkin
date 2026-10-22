import { LogoMark } from '@nextskin/ui'
import type { Page } from '../scenes/page.ts'
import { DensityContext, LiveContext, TimeContext } from './time.ts'
import { Px } from './ui.tsx'

/** 画面的排版尺寸：和介绍视频一样按 1280×720 排版，整体缩放（ADR-0055） */
export const FRAME = { width: 1280, height: 720 } as const

/**
 * 一页的画面，1280×720。t 是这一页播到第几秒，density 是一个排版像素对应几个设备像素，
 * live 为 false 时是静帧（3D 预览换成图）
 */
export function Frame({ page, t, density, live }: { page: Page; t: number; density: number; live: boolean }) {
  return (
    <LiveContext value={live}>
      <DensityContext value={density}>
        <TimeContext value={Math.min(t, page.duration)}>
          <div
            data-palette={page.palette?.(t)}
            className="relative overflow-hidden bg-bg text-text"
            style={{ width: FRAME.width, height: FRAME.height }}
          >
            <page.Scene />
            {page.chapter && <Hud chapter={page.chapter} />}
          </div>
        </TimeContext>
      </DensityContext>
    </LiveContext>
  )
}

/** 角落里的站名和章节号 */
function Hud({ chapter }: { chapter: NonNullable<Page['chapter']> }) {
  return (
    <>
      <div className="absolute flex items-center gap-3" style={{ left: 64, top: 36 }}>
        <LogoMark cell={3} />
        <Px size={24}>NextSkin</Px>
      </div>
      <div className="absolute flex items-center gap-3" style={{ right: 64, top: 36 }}>
        <Px size={24} tone="accent">
          {chapter.no}
        </Px>
        <Px size={24}>{chapter.zh}</Px>
        <Px size={24} tone="muted">
          {chapter.en}
        </Px>
      </div>
    </>
  )
}
