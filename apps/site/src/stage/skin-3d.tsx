import { useEffect, useRef } from 'react'
import type { SkinViewer } from 'skinview3d'
import { PoseImage, SKIN } from './skin.tsx'
import { useDensity, useLive, usePlaying } from './time.ts'

/**
 * 3D 预览：产品里的同一个库（skinview3d），缓慢自转、行走（DESIGN.md §5）。
 * 画布按画面的设备像素倍数出图，不用浏览器的设备像素比：画面整体缩放过。静帧里换成 3D 出图。
 * skinview3d 连着 three.js，比其余的脚本加起来还大，翻到这一页才加载
 */
export function Skin3D({ size }: { size: number }) {
  const live = useLive()
  const density = useDensity()
  const playing = usePlaying()
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<SkinViewer>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing

  useEffect(() => {
    if (!live) return
    let v: SkinViewer | null = null
    let cancelled = false
    void import('skinview3d').then(({ SkinViewer, WalkingAnimation }) => {
      if (cancelled) return
      v = new SkinViewer({
        canvas: canvas.current!,
        width: size,
        height: size,
        pixelRatio: density,
        fov: 40,
        zoom: 0.86,
      })
      v.autoRotateSpeed = 0.6
      v.autoRotate = playingRef.current
      v.animation = new WalkingAnimation()
      v.animation.speed = 0.6
      v.animation.paused = !playingRef.current
      void v.loadSkin(SKIN, { model: 'slim' })
      viewer.current = v
    })
    return () => {
      cancelled = true
      viewer.current = null
      v?.dispose()
    }
  }, [live, size, density])

  useEffect(() => {
    const v = viewer.current
    if (!v) return
    v.autoRotate = playing
    if (v.animation) v.animation.paused = !playing
  }, [playing])

  if (!live) return <PoseImage name="front-d4" view="front" density={4} />
  return <canvas ref={canvas} aria-hidden style={{ width: size, height: size, display: 'block' }} />
}
