'use client'

import { decodePng, normalizeTexture, prepareSkin, type Rgba, type TextureType } from '@nextskin/skin'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type * as Skinview3d from 'skinview3d'
import { SegmentedControl } from '../segmented-control/segmented-control.tsx'
import { Stage } from '../stage/stage.tsx'
import { Switch } from '../switch/switch.tsx'

export interface SkinViewerLabels {
  /** 画布的替代文字，例如“初音未来的 3D 预览” */
  viewer: string
  /** 动作选择的名称和三个选项 */
  animation: string
  idle: string
  walk: string
  run: string
  /** 外层（帽子、外套、袖子、裤腿）的开关 */
  outerLayer: string
  loading: string
  failed: string
}

export interface SkinViewerProps {
  /** 材质 PNG 的地址，例如 `/textures/{hash}`。材质放在 S3 或 CDN 上时，那边要配 CORS（ADR-0017） */
  src: string
  /** 模型取材质条目的类型，不重新推断；披风单独显示，不带人物 */
  type: TextureType
  labels: SkinViewerLabels
  /**
   * 是否自动旋转、播放动作。默认跟随系统的“减少动态效果”：开启时不转也不动（DESIGN.md §5）。
   * 截图测试传 false，画面才是确定的
   */
  motion?: boolean
}

type Animation = 'idle' | 'walk' | 'run'

// 与服务端出图相同的解码上限（ADR-0008）
const limits = { maxWidth: 1024, maxHeight: 1024, maxInflatedBytes: 9 * 1024 * 1024 }

/**
 * 取回 PNG，用 JS 解码器解码，皮肤按游戏的规则前处理（基础层强制不透明）后画到 canvas 上交给 skinview3d。
 * 不让它自己加载图片：canvas 按预乘 alpha 存像素，透明像素原有的 RGB 会丢，而游戏会把基础层的这些像素显示出来
 * （ADR-0025、packages/skin/AGENTS.md）
 */
async function loadTexture(src: string, type: TextureType, signal: AbortSignal): Promise<HTMLCanvasElement> {
  const response = await fetch(src, { signal })
  if (!response.ok) throw new Error(`材质加载失败：HTTP ${response.status}`)
  const decoded = await decodePng(new Uint8Array(await response.arrayBuffer()), limits)
  const image: Rgba = type === 'cape' ? normalizeTexture(decoded, 'cape') : prepareSkin(decoded)
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  canvas
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
  return canvas
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(callback: () => void) {
  const query = matchMedia(REDUCED_MOTION)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}
const prefersReducedMotion = () => matchMedia(REDUCED_MOTION).matches

/**
 * 材质详情的 3D 预览，是详情页的视觉中心（DESIGN.md §2）：放在带网格的展台上，最近邻过滤，背景透明；
 * 默认缓慢自动旋转，可以拖动；动作可选站立、行走、奔跑，可以隐藏外层。宽度占满父元素
 */
export function SkinViewer({ src, type, labels, motion }: SkinViewerProps) {
  const container = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<Skinview3d.SkinViewer | null>(null)
  const animations = useRef<typeof Skinview3d | null>(null)
  // 加载结果记在哪张材质名下：换了材质，没有结果之前就是“加载中”，不用在 effect 里同步重置状态
  const key = `${type}:${src}`
  const [result, setResult] = useState<{ key: string; status: 'ready' | 'failed' } | null>(null)
  const status = result?.key === key ? result.status : 'loading'
  const [animation, setAnimation] = useState<Animation>('walk')
  const [outerLayer, setOuterLayer] = useState(true)
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false)
  const moving = motion ?? !reducedMotion

  useEffect(() => {
    const controller = new AbortController()
    let instance: Skinview3d.SkinViewer | null = null
    // three.js 很大，只在真正显示 3D 预览时才加载
    Promise.all([import('skinview3d'), loadTexture(src, type, controller.signal)])
      .then(([module, texture]) => {
        if (controller.signal.aborted || !canvas.current || !container.current) return
        animations.current = module
        instance = new module.SkinViewer({
          canvas: canvas.current,
          width: container.current.clientWidth,
          height: container.current.clientHeight,
          pixelRatio: 'match-device',
        })
        if (type === 'cape') {
          // 没有加载皮肤，人物不显示；转过来让披风的外侧朝向镜头
          instance.loadCape(texture)
          instance.playerWrapper.rotation.y = Math.PI
          instance.zoom = 1.2
        } else {
          instance.loadSkin(texture, { model: type === 'alex' ? 'slim' : 'default' })
          // 起始角度偏 30°：不转的时候（减少动态效果）也看得出是立体的
          instance.playerWrapper.rotation.y = Math.PI / 6
        }
        instance.autoRotateSpeed = 0.5
        // 不转也不动时暂停渲染循环（见下面的 effect），拖动视角时按需重绘一帧
        const viewerInstance = instance
        instance.controls.addEventListener('change', () => {
          if (viewerInstance.renderPaused) viewerInstance.render()
        })
        viewer.current = instance
        setResult({ key, status: 'ready' })
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ key, status: 'failed' })
      })
    return () => {
      controller.abort()
      viewer.current = null
      instance?.dispose()
    }
  }, [key, src, type])

  // 动作、旋转和外层随状态切换，不重建场景
  useEffect(() => {
    const instance = viewer.current
    const module = animations.current
    if (status !== 'ready' || !instance || !module) return
    instance.autoRotate = moving
    if (!moving || type === 'cape') instance.animation = null
    else
      instance.animation =
        animation === 'run'
          ? new module.RunningAnimation()
          : animation === 'walk'
            ? new module.WalkingAnimation()
            : new module.IdleAnimation()
    instance.playerObject.skin.setOuterLayerVisible(outerLayer)
    // skinview3d 默认每帧重绘。不转也不动时画面不变，停掉循环，只画这一帧：开着“减少动态效果”的设备不白白耗电，
    // 没有 GPU 的环境（无头浏览器的软件渲染）也不会被它占满 CPU
    instance.renderPaused = !moving
    if (!moving) instance.render()
  }, [status, moving, animation, outerLayer, type])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      const instance = viewer.current
      if (!instance) return
      instance.setSize(element.clientWidth, element.clientHeight)
      if (instance.renderPaused) instance.render()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div ref={container} className="relative h-96 lg:h-120">
        <Stage grid>
          {status !== 'ready' && (
            <p role="status" className="px-4 text-center text-sm text-text-muted">
              {status === 'loading' ? labels.loading : labels.failed}
            </p>
          )}
        </Stage>
        <canvas
          ref={canvas}
          role="img"
          aria-label={labels.viewer}
          className="absolute inset-0 size-full cursor-grab touch-none active:cursor-grabbing"
          hidden={status !== 'ready'}
        />
      </div>
      {type !== 'cape' && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            size="sm"
            aria-label={labels.animation}
            value={animation}
            onValueChange={setAnimation}
            disabled={!moving || status !== 'ready'}
            options={[
              { value: 'idle', label: labels.idle },
              { value: 'walk', label: labels.walk },
              { value: 'run', label: labels.run },
            ]}
          />
          <Switch checked={outerLayer} onCheckedChange={setOuterLayer} disabled={status !== 'ready'}>
            {labels.outerLayer}
          </Switch>
        </div>
      )}
    </div>
  )
}
