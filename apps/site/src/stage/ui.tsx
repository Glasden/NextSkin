import { cx, stageGrid } from '@nextskin/ui'
import type { CSSProperties, ReactNode } from 'react'

// 场景用的排版原语。画面按 1280×720 排版，尺寸写在内联样式里；颜色只用 theme.css 的 token 类（不变量 10），
// 亮暗模式和第 7 页的换主题都只换 CSS 变量

/** 文字颜色 */
export type Tone =
  | 'text'
  | 'muted'
  | 'inverse'
  | 'accent'
  | 'accent-fg'
  | 'success'
  | 'success-fg'
  | 'warning'
  | 'warning-fg'
  | 'danger'
  | 'danger-fg'

export const toneClass: Record<Tone, string> = {
  text: 'text-text',
  muted: 'text-text-muted',
  inverse: 'text-text-inverse',
  accent: 'text-accent',
  'accent-fg': 'text-accent-fg',
  success: 'text-success',
  'success-fg': 'text-success-fg',
  warning: 'text-warning',
  'warning-fg': 'text-warning-fg',
  danger: 'text-danger',
  'danger-fg': 'text-danger-fg',
}

const fillClass: Record<Tone, string> = {
  text: 'fill-text',
  muted: 'fill-text-muted',
  inverse: 'fill-text-inverse',
  accent: 'fill-accent',
  'accent-fg': 'fill-accent-fg',
  success: 'fill-success',
  'success-fg': 'fill-success-fg',
  warning: 'fill-warning',
  'warning-fg': 'fill-warning-fg',
  danger: 'fill-danger',
  'danger-fg': 'fill-danger-fg',
}

/** 像素字体只按 12px 的整数倍用（DESIGN.md §4） */
export type PixelSize = 12 | 24 | 36 | 48 | 60 | 72 | 96 | 120

export function Px({
  size = 24,
  tone = 'text',
  as: Tag = 'div',
  wrap = false,
  children,
  className,
  style,
}: {
  size?: PixelSize
  tone?: Tone
  /** 静帧页的标题要用 h1、h2 */
  as?: 'div' | 'h1' | 'h2' | 'p'
  /** 画面里的字按排版原样不折行；静帧页的文字按屏幕宽度折行 */
  wrap?: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <Tag
      className={cx(
        'font-pixel tabular-nums',
        wrap ? 'whitespace-normal' : 'whitespace-pre',
        toneClass[tone],
        className,
      )}
      style={{ fontSize: size, lineHeight: `${(size * 4) / 3}px`, ...style }}
    >
      {children}
    </Tag>
  )
}

/** 正文字体：说明文字、用户产生的内容（材质名、角色名） */
export function Sans({
  size = 18,
  tone = 'text',
  bold = false,
  children,
  style,
}: {
  size?: number
  tone?: Tone
  bold?: boolean
  children: ReactNode
  style?: CSSProperties
}) {
  return (
    <div
      className={cx('font-sans', bold && 'font-bold', toneClass[tone])}
      style={{ fontSize: size, lineHeight: 1.5, ...style }}
    >
      {children}
    </div>
  )
}

/** 等宽字体：代码、命令、hash */
export function Mono({
  size = 16,
  tone = 'text',
  children,
  className,
  style,
}: {
  size?: number
  tone?: Tone
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={cx('font-mono whitespace-pre', toneClass[tone], className)}
      style={{ fontSize: size, lineHeight: 1.55, ...style }}
    >
      {children}
    </div>
  )
}

/** 中文标题加英文副标题 */
export function Title({
  zh,
  en,
  size = 48,
  style,
  align = 'left',
}: {
  zh: ReactNode
  en: ReactNode
  size?: 36 | 48 | 72 | 96
  style?: CSSProperties
  align?: 'left' | 'center'
}) {
  return (
    <div style={{ textAlign: align, ...style }}>
      <Px size={size}>{zh}</Px>
      <Px size={24} tone="muted" style={{ marginTop: 8 }}>
        {en}
      </Px>
    </div>
  )
}

export type Surface = 'surface' | 'sunken' | 'raised' | 'accent-subtle' | 'stage' | 'bg' | 'accent' | 'success' | 'none'
export type Edge = 'border' | 'strong' | 'accent' | 'danger' | 'success' | 'none'

const surfaceClass: Record<Surface, string> = {
  surface: 'bg-surface',
  sunken: 'bg-surface-sunken',
  raised: 'bg-surface-raised',
  'accent-subtle': 'bg-accent-subtle',
  stage: 'bg-stage',
  bg: 'bg-bg',
  accent: 'bg-accent',
  success: 'bg-success',
  none: 'bg-transparent',
}

const edgeClass: Record<Edge, string> = {
  border: 'border-border',
  strong: 'border-border-strong',
  accent: 'border-accent',
  danger: 'border-danger',
  success: 'border-success',
  none: 'border-transparent',
}

/** 硬边位移阴影只有 2px 和 4px 两档（DESIGN.md §2） */
export type ShadowSize = 0 | 2 | 4

export const shadowClass: Record<ShadowSize, string | undefined> = {
  0: undefined,
  2: 'shadow-pixel',
  4: 'shadow-pixel-lg',
}

/** 卡片和面板：小圆角、硬边位移阴影（DESIGN.md §2） */
export function Panel({
  children,
  shadow = 4,
  bg = 'surface',
  edge = 'border',
  thick = false,
  dashed = false,
  square = false,
  className,
  style,
}: {
  children?: ReactNode
  shadow?: ShadowSize
  bg?: Surface
  edge?: Edge
  /** 2px 边框：强调和选中 */
  thick?: boolean
  /** 虚线框：还没出现、已经退出的东西 */
  dashed?: boolean
  /** 直角：高对比主题 */
  square?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={cx(
        surfaceClass[bg],
        edgeClass[edge],
        thick ? 'border-2' : 'border',
        dashed && 'border-dashed',
        square ? 'rounded-none' : 'rounded-md',
        shadowClass[shadow],
        className,
      )}
      style={style}
    >
      {children}
    </div>
  )
}

/** 展台：stage 底色加 16px 网格（packages/ui 的 stageGrid）。子元素按展台的左上角绝对定位 */
export function Stage({
  children,
  grid = true,
  style,
}: {
  children?: ReactNode
  grid?: boolean
  style?: CSSProperties
}) {
  return (
    <div
      className={cx('relative overflow-hidden rounded-md border border-border bg-stage', grid && stageGrid)}
      style={style}
    >
      {children}
    </div>
  )
}

/** 像素图标：一个字符一格，# 是填色 */
export function PixelIcon({ rows, cell, tone }: { rows: readonly string[]; cell: number; tone: Tone }) {
  const w = rows[0]!.length
  return (
    <svg
      aria-hidden
      width={w * cell}
      height={rows.length * cell}
      viewBox={`0 0 ${w} ${rows.length}`}
      shapeRendering="crispEdges"
      className={cx('block shrink-0', fillClass[tone])}
    >
      {rows.flatMap((row, y) =>
        [...row].map((ch, x) => (ch === '#' ? <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} /> : null)),
      )}
    </svg>
  )
}

export const icons = {
  check: ['........', '.......#', '......##', '#....##.', '##..##..', '.####...', '..##....', '........'],
  lock: ['..####..', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '########'],
  arrow: ['....#...', '....##..', '########', '########', '....##..', '....#...'],
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  star: ['.#.', '###', '.#.'],
  cross: ['##....##', '###..###', '.######.', '..####..', '..####..', '.######.', '###..###', '##....##'],
} as const

/** 状态码、结论这类小块：实心底色，像素字 */
export type PillTone = 'accent' | 'success' | 'warning' | 'danger' | 'text'

const pillClass: Record<PillTone, [string, Tone]> = {
  accent: ['bg-accent', 'accent-fg'],
  success: ['bg-success', 'success-fg'],
  warning: ['bg-warning', 'warning-fg'],
  danger: ['bg-danger', 'danger-fg'],
  text: ['bg-text', 'inverse'],
}

export function Pill({ children, tone, size = 24 }: { children: ReactNode; tone: PillTone; size?: 12 | 24 }) {
  const [bg, fg] = pillClass[tone]
  return (
    <div className={cx('inline-block', bg)} style={{ padding: size === 24 ? '0 10px' : '0 6px' }}>
      <Px size={size} tone={fg}>
        {children}
      </Px>
    </div>
  )
}

/** 勾和叉：成功、拒绝 */
export function Mark({ ok, cell = 3 }: { ok: boolean; cell?: number }) {
  return <PixelIcon rows={ok ? icons.check : icons.cross} cell={cell} tone={ok ? 'success' : 'danger'} />
}

/** 标签：选中时用强调色淡底、加粗边框和勾选角标（DESIGN.md §2.1：选中态不只靠颜色） */
export function Chip({
  children,
  lit = false,
  shadow = 0,
  mono = false,
  size = 24,
  style,
}: {
  children: ReactNode
  lit?: boolean
  shadow?: ShadowSize
  mono?: boolean
  size?: 12 | 24
  style?: CSSProperties
}) {
  return (
    <div
      className={cx(
        'relative inline-flex items-center rounded-md',
        lit ? 'border-2 border-accent bg-accent-subtle' : 'border border-border bg-surface',
        shadowClass[shadow],
      )}
      style={{ padding: size === 24 ? '8px 16px' : '4px 10px', ...style }}
    >
      {mono ? (
        <span className="font-mono whitespace-pre text-text" style={{ fontSize: size === 24 ? 20 : 14 }}>
          {children}
        </span>
      ) : (
        <Px size={size}>{children}</Px>
      )}
      {lit && (
        <div className="absolute rounded-bl-md bg-accent" style={{ right: -1, top: -1, padding: 2 }}>
          <PixelIcon rows={icons.check} cell={2} tone="accent-fg" />
        </div>
      )}
    </div>
  )
}

/** 终端：等宽字体（DESIGN.md §4），沉在页面里的底色 */
export function Terminal({
  children,
  shadow = 4,
  style,
}: {
  children: ReactNode
  shadow?: ShadowSize
  style?: CSSProperties
}) {
  return (
    <Panel bg="sunken" shadow={shadow} className="font-mono text-text" style={{ padding: '24px 28px', ...style }}>
      {children}
    </Panel>
  )
}

export function Prompt({
  children,
  size = 22,
  cursor = false,
}: {
  children: ReactNode
  size?: number
  cursor?: boolean
}) {
  return (
    <div className="font-mono whitespace-pre text-text" style={{ fontSize: size, lineHeight: 1.6 }}>
      <span className="text-accent">$ </span>
      {children}
      {cursor && (
        <span
          className="inline-block bg-accent"
          style={{ width: size * 0.6, height: size * 1.1, verticalAlign: 'text-bottom', marginLeft: 2 }}
        />
      )}
    </div>
  )
}

/** 场景的画布：1280×720，左右留 64px，顶上给角落的站名和章节号留位置 */
export function Scene({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="absolute inset-0" style={{ padding: '96px 64px 56px', ...style }}>
      {children}
    </div>
  )
}

/** 铺满画布、内容居中 */
export function Center({ children, gap, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ gap, ...style }}>
      {children}
    </div>
  )
}

export const abs = (left: number, top: number, extra?: CSSProperties): CSSProperties => ({
  position: 'absolute',
  left,
  top,
  ...extra,
})
