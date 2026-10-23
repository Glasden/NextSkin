import { cx } from '@nextskin/ui'
import type { ReactNode } from 'react'
import { Skin3D } from '../stage/skin-3d.tsx'
import { Head, PoseImage } from '../stage/skin.tsx'
import { BEAT, barsFrom, enter, useT } from '../stage/time.ts'
import { abs, Chip, icons, Mono, PixelIcon, Px, Scene, Stage, Title } from '../stage/ui.tsx'
import type { Page, Palette } from './page.ts'

const at = barsFrom(29)

const W = 270
const H = 216
const GAP = 24

// 八格亮完以后，整页依次换上三套备选主题，再回到默认的钻石青（DESIGN.md 附录）
const THEMES = at(31)
const themes: { palette: Palette | undefined; zh: string; en: string }[] = [
  { palette: 'cobalt', zh: '钴蓝', en: 'Cobalt' },
  { palette: 'magenta', zh: '洋红', en: 'Magenta' },
  { palette: 'contrast', zh: '高对比', en: 'High Contrast' },
  { palette: undefined, zh: '钻石青', en: 'Diamond' },
]
const THEME_STEP = 2 * BEAT
const themeIndex = (t: number) => (t < THEMES ? -1 : Math.min(themes.length - 1, Math.floor((t - THEMES) / THEME_STEP)))
const paletteAt = (t: number) => themes[themeIndex(t)]?.palette

/** 一格里的小方块：材质、按钮这类东西的缩影 */
function Cell({
  children,
  lit = false,
  w = 22,
  h = 34,
}: {
  children?: ReactNode
  lit?: boolean
  w?: number
  h?: number
}) {
  return (
    <div
      className={cx(
        'grid place-items-center border',
        lit ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-sunken',
      )}
      style={{ width: w, height: h }}
    >
      {children}
    </div>
  )
}

const tiles: { zh: string; en: string; body: ReactNode }[] = [
  {
    zh: '皮肤库',
    en: 'SKIN LIBRARY',
    body: (
      <Stage style={{ width: '100%', height: 148 }}>
        <div className="absolute inset-0 grid place-items-center">
          <PoseImage name="both-d4" view="both" density={4} />
        </div>
      </Stage>
    ),
  },
  {
    zh: '3D 预览',
    en: '3D PREVIEW',
    body: (
      <Stage style={{ width: '100%', height: 148 }}>
        <div className="absolute inset-0 grid place-items-center">
          <Skin3D size={148} />
        </div>
      </Stage>
    ),
  },
  {
    zh: '衣柜',
    en: 'CLOSET',
    body: (
      <div className="grid justify-center" style={{ gridTemplateColumns: 'repeat(4, 48px)', gap: 10, paddingTop: 12 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className={cx(
              'grid place-items-center bg-stage',
              i === 2 ? 'border-2 border-accent' : 'border border-border',
            )}
            style={{ width: 48, height: 48 }}
          >
            {i % 3 === 2 ? (
              <Head size={32} />
            ) : (
              <div className="bg-text" style={{ width: 24, height: 24, opacity: i % 2 ? 0.14 : 0.08 }} />
            )}
          </div>
        ))}
      </div>
    ),
  },
  {
    zh: '领奖台',
    en: 'PODIUM',
    body: (
      <div className="flex items-end justify-center" style={{ gap: 6, height: 148 }}>
        {[
          [2, 56],
          [1, 84],
          [3, 40],
        ].map(([rank, h]) => (
          <div key={rank} className="flex flex-col items-center" style={{ gap: 4 }}>
            {rank === 1 && <Head size={48} />}
            <div
              className={cx(
                'grid place-items-center border border-border',
                rank === 1 ? 'bg-accent' : 'bg-surface-sunken',
              )}
              style={{ width: 64, height: h }}
            >
              <Px size={24} tone={rank === 1 ? 'accent-fg' : 'muted'}>
                {rank}
              </Px>
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    zh: '外置登录',
    en: 'YGGDRASIL',
    body: (
      <div style={{ paddingTop: 16 }}>
        <Mono size={12} tone="muted">
          authlib-injector
        </Mono>
        <Mono size={12}>skin.example.com/api/yggdrasil</Mono>
        <Px size={12} tone="muted" style={{ marginTop: 12 }}>
          设备码 DEVICE CODE
        </Px>
        <div className="flex" style={{ gap: 4, marginTop: 4 }}>
          {'KQ7M-D2XF'.split('').map((ch, i) =>
            ch === '-' ? (
              <div key={i} style={{ width: 10 }} />
            ) : (
              <Cell key={i} h={30}>
                <Px size={24}>{ch}</Px>
              </Cell>
            ),
          )}
        </div>
      </div>
    ),
  },
  {
    zh: '两步验证',
    en: '2FA · PASSKEYS',
    body: (
      <div className="flex items-center justify-center" style={{ gap: 16, height: 148 }}>
        <PixelIcon rows={icons.lock} cell={8} tone="accent" />
        <div className="flex" style={{ gap: 4 }}>
          {'482913'.split('').map((d, i) => (
            <Cell key={i}>
              <Px size={24}>{d}</Px>
            </Cell>
          ))}
        </div>
      </div>
    ),
  },
  {
    zh: '第三方登录',
    en: 'OAUTH',
    body: (
      <div className="flex flex-wrap" style={{ gap: 8, paddingTop: 16 }}>
        {['GitHub', 'Microsoft', 'Google', 'LittleSkin'].map((name) => (
          <Chip key={name} size={12}>
            {name}
          </Chip>
        ))}
      </div>
    ),
  },
  {
    zh: '签到积分',
    en: 'CHECK-IN',
    body: (
      <div style={{ paddingTop: 18 }}>
        <div className="flex" style={{ gap: 6 }}>
          {Array.from({ length: 7 }, (_, i) => (
            <Cell key={i} lit={i < 5} w={28} h={28}>
              {i < 5 && <PixelIcon rows={icons.check} cell={2} tone="accent" />}
            </Cell>
          ))}
        </div>
        <Px size={36} tone="accent" style={{ marginTop: 14 }}>
          +10
        </Px>
      </div>
    ),
  },
]

/** 玩家看得到的功能，八格一格一格亮起；然后整页依次换上四套主题，每套都有亮暗两种 */
function Players() {
  const t = useT()
  const lit = Math.floor((t - at(29)) / BEAT)
  const theme = themeIndex(t)
  const contrast = paletteAt(t) === 'contrast'
  return (
    <Scene>
      <Title zh="玩家要的，都有" en="Everything players expect" />
      <div style={abs(816, 120, { width: 400, textAlign: 'right', ...enter(t, THEMES) })}>
        <Px size={12} tone="muted">
          主题 {Math.max(1, theme + 1)} / 4 · THEMES
        </Px>
        <Px size={36}>
          {themes[Math.max(0, theme)]!.zh}
          <span className="text-text-muted" style={{ fontSize: 24 }}>
            {' '}
            {themes[Math.max(0, theme)]!.en}
          </span>
        </Px>
        <Px size={12} tone="muted">
          每套都有亮色和暗色 · LIGHT AND DARK
        </Px>
      </div>
      {tiles.map((tile, i) => {
        const on = i <= lit
        const now = i === lit
        return (
          <div
            key={tile.zh}
            className={cx(
              'flex flex-col rounded-md bg-surface',
              now ? 'border-2 border-accent' : contrast ? 'border-2 border-border-strong' : 'border border-border',
              (now || contrast) && 'shadow-pixel-lg',
            )}
            style={abs(64 + (i % 4) * (W + GAP), 220 + Math.floor(i / 4) * (H + 16), {
              width: W,
              height: H,
              padding: '10px 14px',
              opacity: on ? 1 : 0.25,
            })}
          >
            <div className="flex-1">{tile.body}</div>
            <div className="flex items-baseline" style={{ gap: 10 }}>
              <Px size={24}>{tile.zh}</Px>
              <Px size={12} tone="muted">
                {tile.en}
              </Px>
            </div>
          </div>
        )
      })}
    </Scene>
  )
}

export const players: Page = {
  id: 'players',
  Scene: Players,
  duration: THEMES + themes.length * THEME_STEP,
  hold: 3,
  chapter: { no: '05', zh: '玩家', en: 'PLAYERS' },
  palette: paletteAt,
  text: {
    title: '玩家要的，都有',
    en: 'Everything players expect',
    body: [
      '皮肤库、3D 预览、衣柜、本周收藏最多的领奖台、外置登录（authlib-injector，以及 Yggdrasil Connect 的设备码登录）、两步验证和通行密钥、GitHub / Microsoft / Google / LittleSkin 第三方登录、签到积分。',
      '界面有亮色和暗色两种模式，默认跟随系统。默认配色是钻石青；官方插件“更多配色”另带钴蓝、洋红和高对比三套（高对比还换上直角、粗边框和带阴影的卡片），站长启用以后用户自己挑，每套都有亮暗两种。',
    ],
  },
}
