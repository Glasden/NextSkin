import repoData from '../gen/repo-data.json'
import { RawTexture } from '../stage/skin.tsx'
import { barsFrom, EIGHTH, enter, SIXTEENTH, useT } from '../stage/time.ts'
import { abs, Mark, Mono, Panel, Px, Sans, Scene, Title } from '../stage/ui.tsx'
import type { Page } from './page.ts'

const at = barsFrom(5)

const { encodings, pixelHash, pixelStrip } = repoData
const ROW = 32
const COLS = '226px 76px 384px 1fr'
const STRIP = 22
const CELL = 14

const fmtBytes = (n: number) => `${n.toLocaleString('en-US').replace(/,/g, ' ')} B`
const rowAt = (i: number) => at(5) + i * EIGHTH
const pixelAt = (i: number) => at(6, 4) + (i * SIXTEENTH) / 2

/**
 * 同一组像素的九种 PNG 文件，九个文件 hash 一行一行出现；像素流进 sha256，打出唯一的像素 hash，
 * 再一行一行对上，最后落 9 → 1
 */
function PixelHash() {
  const t = useT()
  const typed = Math.max(0, Math.min(64, Math.floor((t - at(6, 2)) / SIXTEENTH + 1) * 8))
  const flow = Math.max(0, Math.floor((t - at(6)) / SIXTEENTH))

  return (
    <Scene>
      <Title zh="材质按像素存，不按文件存" en="Textures are keyed by their pixels, not their bytes" />
      <div style={abs(64, 214)}>
        <RawTexture scale={3} />
        <Px size={12} tone="muted" style={{ marginTop: 10 }}>
          default-skin.png · 64×64
        </Px>
        <div style={{ marginTop: 18, ...enter(t, at(7)) }}>
          <Px size={48} tone="accent">
            {encodings.length} → 1
          </Px>
          <Px size={12} tone="muted">
            {encodings.length} 个文件 hash，1 个像素 hash
          </Px>
        </div>
      </div>
      <div style={abs(288, 208, { width: 928 })}>
        <div className="grid items-center" style={{ gridTemplateColumns: COLS, gap: 12, height: ROW }}>
          <Px size={12} tone="muted">
            同一组像素的 {encodings.length} 种文件
          </Px>
          <Px size={12} tone="muted" style={{ textAlign: 'right' }}>
            大小
          </Px>
          <Px size={12} tone="muted">
            文件的 sha256 · FILE HASH
          </Px>
          <Px size={12} tone="muted">
            像素 hash · PIXEL HASH
          </Px>
        </div>
        {encodings.map((e, i) => (
          <div
            key={e.label}
            className="grid items-center border-t border-border"
            style={{ gridTemplateColumns: COLS, gap: 12, height: ROW, ...enter(t, rowAt(i), 8) }}
          >
            <Sans size={15} tone={i === 0 ? 'text' : 'muted'}>
              {e.label}
            </Sans>
            <Mono size={14} tone="muted" style={{ textAlign: 'right' }}>
              {fmtBytes(e.size)}
            </Mono>
            <Mono size={15}>{e.fileHash.slice(0, 38)}…</Mono>
            {t >= pixelAt(i) && (
              <div className="flex items-center" style={{ gap: 8 }}>
                <Mono size={15} tone="accent">
                  {pixelHash.slice(0, 12)}…
                </Mono>
                <Mark ok cell={2} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={abs(64, 556, { width: 1152, ...enter(t, at(6)) })}>
        <Panel
          bg="sunken"
          shadow={4}
          className="flex items-center"
          style={{ height: 120, padding: '14px 24px', gap: 24 }}
        >
          {/* 像素流：脸部 8×8 的颜色往右流，流进 sha256。颜色是材质自己的像素 */}
          <svg aria-hidden className="shrink-0" width={STRIP * CELL} height={CELL * 2 + 4}>
            {Array.from({ length: STRIP * 2 }, (_, i) => (
              <rect
                key={i}
                x={(i % STRIP) * CELL}
                y={Math.floor(i / STRIP) * (CELL + 4)}
                width={CELL - 2}
                height={CELL}
                fill={pixelStrip[(((i - flow) % pixelStrip.length) + pixelStrip.length) % pixelStrip.length]}
              />
            ))}
          </svg>
          <div className="flex-1">
            <Mono size={20}>
              <span className="text-accent">sha256</span>( u32be(64) ‖ u32be(64) ‖ RGBA8 × 4096 )
            </Mono>
            <Mono size={18} tone="accent" style={{ marginTop: 6 }}>
              = {pixelHash.slice(0, typed)}
            </Mono>
            <Px size={12} tone="muted" style={{ marginTop: 6 }}>
              换编码器、换 zlib 版本、换 CPU 架构都不变 · 既是存储键，也是公开地址的一部分
            </Px>
          </div>
        </Panel>
      </div>
    </Scene>
  )
}

export const pixelHashPage: Page = {
  id: 'pixel-hash',
  Scene: PixelHash,
  duration: at(7) + SIXTEENTH,
  hold: 5,
  chapter: { no: '06', zh: '材质', en: 'TEXTURES' },
  text: {
    title: '材质按像素存，不按文件存',
    en: 'Textures are keyed by their pixels, not their bytes',
    body: [
      '同一张皮肤，换个编辑器保存、换个压缩级别，文件的 sha256 就全变了。NextSkin 的材质 hash 算的是像素：sha256(宽 ‖ 高 ‖ RGBA 像素)。上面九种文件解出来是同一组像素，hash 只有一个。',
      '这个 hash 既是存储键，也是公开材质地址的一部分。换编码器、换 zlib 版本、换 CPU 架构都不会变；已经存下的文件也永远不重新编码。',
    ],
  },
}
