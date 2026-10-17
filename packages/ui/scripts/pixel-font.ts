/**
 * 生成像素字体的分片和 src/fonts/fonts.css（DESIGN.md §4）。换字体版本时改 FONT，再运行 `pnpm font:sync`。
 *
 * 分两个字族，unicode-range 都写成连续区间，CSS 很短：
 * - 'Fusion Pixel 12'：拉丁字母和常用符号一片；常用汉字（《通用规范汉字表》一级字，加上界面用到的个别二级字）、
 *   CJK 标点和全角字符一片。汉字那片的 unicode-range 覆盖整个基本区，缺的字加载后找不到字形，
 *   浏览器按 font-family 的顺序去下一个字族里找。
 * - 'Fusion Pixel 12 Ext'：其余字形按文字分组、按码位切片，页面用到其中的字才下载。
 *
 * 一级字取自 Unihan 的 kTGH（字表序号 1–3500）。没有按字频细分：字频表来自 1980 年代的语料，
 * 界面用字（登录、注册、邮箱、页码……）散落在整个一级字表里，细分后一个页面照样要下载每一片。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import { Blob as HbBlob, Face } from 'harfbuzzjs'
import subsetFont from 'subset-font'
import { compress, decompress } from 'wawoff2'

const FONT = {
  version: '2026.09.25',
  url: 'https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.09.25/fusion-pixel-font-12px-proportional-otf.woff2-v2026.09.25.zip',
  sha256: '44b456f6f920d700f98d5865e03152d6a7357ed0a8ee388376ac0530d2d57072',
  file: 'fusion-pixel-12px-proportional-zh_hans.otf.woff2',
}
const UNIHAN = {
  url: 'https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip',
  sha256: 'f7a48b2b545acfaa77b2d607ae28747404ce02baefee16396c5d2d7a8ef34b5e',
  file: 'Unihan_OtherMappings.txt',
}

const FAMILY = 'Fusion Pixel 12'
const EXT_FAMILY = 'Fusion Pixel 12 Ext'

type Range = readonly [number, number]

// 拉丁字母、标点，以及行内会用到的符号：箭头、几何图形、♥ ★ 这类杂项符号
const LATIN_RANGES: Range[] = [
  [0x0000, 0x00ff],
  [0x2000, 0x206f],
  [0x2100, 0x21ff],
  [0x25a0, 0x26ff],
]
// 汉字那一片的 unicode-range：CJK 标点、基本区、全角字符。基本区里只放常用字，其余的在补充字族里
const URO: Range = [0x4e00, 0x9fff]
const HAN_RANGES: Range[] = [[0x3000, 0x303f], URO, [0xff00, 0xffef]]
// 界面常用、但不在一级字表里的字
const EXTRA_COMMON = '昵'

// 每片字数的上限，按字形的平均大小定，每片约 30 KB。按上限算出片数后再均分
const CHUNK_SIZE = { han: 1000, hangul: 3000, other: 1500 }

const HAN_BLOCKS: Range[] = [
  [0x2e80, 0x2fdf],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x3ffff],
]
const HANGUL_BLOCKS: Range[] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
]

const outDir = new URL('../src/fonts/', import.meta.url)
const shardDir = new URL('fusion-pixel/', outDir)
const cacheDir = new URL('../node_modules/.cache/pixel-font/', import.meta.url)

const inRanges = (ranges: Range[], cp: number) => ranges.some(([from, to]) => cp >= from && cp <= to)
const hex = (cp: number) => cp.toString(16).toUpperCase()

async function fetchBytes(url: string) {
  console.log(`下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败：${res.status} ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function download(source: { url: string; sha256: string }) {
  const cached = new URL(source.sha256, cacheDir)
  const data = existsSync(cached) ? readFileSync(cached) : await fetchBytes(source.url)
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== source.sha256) throw new Error(`${source.url} 的 sha256 是 ${actual}，与记录的不符`)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cached, data)
  return data
}

function unzip(zip: Uint8Array, select: (name: string) => boolean) {
  return unzipSync(zip, { filter: (file) => select(file.name) && !file.name.endsWith('/') })
}

function cmapOf(sfnt: Uint8Array) {
  return new Face(new HbBlob(sfnt)).collectUnicodes()
}

/**
 * 码位合并成区间。`bridge` 返回 true 的码位可以夹在区间中间，这样 CSS 只有几 KB：
 * - 主字族里有的字不会落到补充字族上。主字族的分片还在加载时，Chromium、Firefox 和 WebKit 也不会
 *   为这些字提前下载区间重叠的补充分片（2026-10 实测）；
 * - 字体里没有的字本来就要回退到正文字体，偶尔多下载一片也无妨。
 */
function toRanges(codePoints: readonly number[], bridge: (cp: number) => boolean): Range[] {
  const ranges: [number, number][] = []
  for (const cp of codePoints) {
    const last = ranges.at(-1)
    if (last) {
      let next = last[1] + 1
      while (next < cp && bridge(next)) next++
      if (next === cp) {
        last[1] = cp
        continue
      }
    }
    ranges.push([cp, cp])
  }
  return ranges
}

const unicodeRange = (ranges: Range[]) =>
  ranges.map(([from, to]) => (from === to ? `U+${hex(from)}` : `U+${hex(from)}-${hex(to)}`)).join(', ')

interface Shard {
  file: string
  family: string
  codePoints: number[]
  ranges: Range[]
}

function plan(fontCodePoints: readonly number[], common: ReadonlySet<number>): Shard[] {
  const latin = fontCodePoints.filter((cp) => inRanges(LATIN_RANGES, cp))
  const han = fontCodePoints.filter((cp) => inRanges(HAN_RANGES, cp) && (common.has(cp) || !inRanges([URO], cp)))
  const primary = new Set([...latin, ...han])
  const rest = fontCodePoints.filter((cp) => !primary.has(cp))
  const restSet = new Set(rest)

  const groups = { han: [] as number[], hangul: [] as number[], other: [] as number[] }
  for (const cp of rest) {
    const group = inRanges(HAN_BLOCKS, cp) ? 'han' : inRanges(HANGUL_BLOCKS, cp) ? 'hangul' : 'other'
    groups[group].push(cp)
  }

  const shards: Shard[] = [
    { file: 'latin.woff2', family: FAMILY, codePoints: latin, ranges: LATIN_RANGES },
    { file: 'han.woff2', family: FAMILY, codePoints: han, ranges: HAN_RANGES },
  ]
  for (const group of ['other', 'han', 'hangul'] as const) {
    const codePoints = groups[group]
    const count = Math.ceil(codePoints.length / CHUNK_SIZE[group])
    const size = Math.ceil(codePoints.length / count)
    for (let i = 0; i < count; i++) {
      const chunk = codePoints.slice(i * size, (i + 1) * size)
      shards.push({
        file: `${group}-${String(i + 1).padStart(2, '0')}.woff2`,
        family: EXT_FAMILY,
        codePoints: chunk,
        // 区间不能跨过补充字族里别的分片的字，否则同一个字族里的区间互相重叠
        ranges: toRanges(chunk, (cp) => !restSet.has(cp)),
      })
    }
  }
  return shards
}

async function buildShard(font: Uint8Array, shard: Shard) {
  // name 表默认只留 1–6 号，再留下版权（0）、许可证（13）和许可证网址（14）：OFL 要求每份字体都带着它们
  const sfnt = await subsetFont(font, String.fromCodePoint(...shard.codePoints), {
    targetFormat: 'sfnt',
    preserveNameIds: [0, 13, 14],
  })
  // 子集过大时 HarfBuzz 会静默丢掉 CFF 表，这里逐片核对
  const face = new Face(new HbBlob(sfnt))
  if (!face.referenceTable('CFF ')?.length) throw new Error(`${shard.file} 没有 CFF 表`)
  const got = face.collectUnicodes()
  if (got.length !== shard.codePoints.length || shard.codePoints.some((cp, i) => got[i] !== cp)) {
    throw new Error(`${shard.file} 的字符映射与计划不符`)
  }
  return compress(sfnt)
}

function css(shards: Shard[]) {
  const faces = shards.map(
    (shard) => `@font-face {
  font-family: '${shard.family}';
  src: url('./fusion-pixel/${shard.file}') format('woff2');
  font-display: swap;
  unicode-range: ${unicodeRange(shard.ranges)};
}
`,
  )
  return `/*
 * 由 packages/ui/scripts/pixel-font.ts 生成，不要手改（DESIGN.md §4）。
 * Fusion Pixel Font ${FONT.version}，12px 比例宽度，简体中文版。SIL Open Font License 1.1，
 * 许可证见 fusion-pixel/OFL.txt；每个分片的 name 表里也保留了版权和许可证信息。
 */
${faces.join('\n')}`
}

const fontZip = await download(FONT)
const fontFiles = unzip(fontZip, (name) => name === FONT.file || name === 'OFL.txt' || name.startsWith('LICENSES/'))
const font = Buffer.from(await decompress(fontFiles[FONT.file]!))
const fontCodePoints = [...cmapOf(font)].sort((a, b) => a - b)

const common = new Set([...EXTRA_COMMON].map((char) => char.codePointAt(0)!))
const unihan = unzip(await download(UNIHAN), (name) => name === UNIHAN.file)
const mappings = new TextDecoder().decode(unihan[UNIHAN.file])
for (const [, cp, index] of mappings.matchAll(/^U\+([0-9A-F]+)\tkTGH\t2013:(\d+)$/gm)) {
  if (Number(index) <= 3500) common.add(parseInt(cp!, 16))
}
const fontSet = new Set(fontCodePoints)
const missing = [...common].filter((cp) => !fontSet.has(cp))
const outside = [...common].filter((cp) => !inRanges([URO], cp))
if (common.size < 3500 || missing.length > 0 || outside.length > 0) {
  const chars = (cps: number[]) => cps.map((cp) => String.fromCodePoint(cp)).join('')
  throw new Error(`常用字有 ${common.size} 个，字体缺 ${chars(missing)}，不在基本区的有 ${chars(outside)}`)
}

const shards = plan(fontCodePoints, common)
const covered = shards.reduce((sum, shard) => sum + shard.codePoints.length, 0)
if (covered !== fontCodePoints.length) throw new Error(`分片覆盖 ${covered} 个码位，字体有 ${fontCodePoints.length} 个`)

rmSync(shardDir, { recursive: true, force: true })
for (const [name, data] of Object.entries(fontFiles)) {
  if (name !== FONT.file) {
    mkdirSync(new URL('.', new URL(name, shardDir)), { recursive: true })
    writeFileSync(new URL(name, shardDir), data)
  }
}

let total = 0
for (const shard of shards) {
  const woff2 = await buildShard(font, shard)
  writeFileSync(new URL(shard.file, shardDir), woff2)
  total += woff2.length
  console.log(
    `${shard.file.padEnd(16)} ${String(shard.codePoints.length).padStart(5)} 字  ${(woff2.length / 1024).toFixed(1).padStart(6)} KB`,
  )
}
writeFileSync(new URL('fonts.css', outDir), css(shards))
console.log(`${shards.length} 个分片，共 ${(total / 1024).toFixed(0)} KB`)
