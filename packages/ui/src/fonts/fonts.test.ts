import { describe, expect, it } from 'vitest'
import fontsCss from './fonts.css?raw'
import './fonts.css'

// 像素字体按 unicode-range 分片，浏览器只下载页面用到的分片（DESIGN.md §4、scripts/pixel-font.ts）
const FAMILY = 'Fusion Pixel 12'
const EXT_FAMILY = 'Fusion Pixel 12 Ext'

type Range = [number, number]

function parseRanges(unicodeRange: string): Range[] {
  return unicodeRange.split(',').map((part) => {
    const [from = '', to = from] = part.trim().replace(/^U\+/i, '').split('-')
    return [parseInt(from, 16), parseInt(to, 16)]
  })
}

const covers = (ranges: Range[], cp: number) => ranges.some(([from, to]) => cp >= from && cp <= to)
const familyOf = (face: FontFace) => face.family.replace(/^["']|["']$/g, '')

function pixelFaces() {
  return [...document.fonts].filter((face) => familyOf(face).startsWith(FAMILY))
}

function faceFor(family: string, char: string) {
  const cp = char.codePointAt(0)!
  const face = pixelFaces().find((face) => familyOf(face) === family && covers(parseRanges(face.unicodeRange), cp))
  if (!face) throw new Error(`${family} 里没有覆盖 ${char} 的分片`)
  return face
}

async function show(text: string) {
  const element = document.createElement('p')
  element.style.font = `24px '${FAMILY}', '${EXT_FAMILY}', sans-serif`
  element.textContent = text
  document.body.append(element)
  await document.fonts.ready
}

// 失败信息里用字族加第一段区间指代分片
const label = (face: FontFace) => `${familyOf(face)} ${face.unicodeRange.split(',')[0]}`

/** 等这些分片下载完，再确认没有别的分片被下载 */
async function expectLoaded(...faces: FontFace[]) {
  for (const face of faces) await expect.poll(() => face.status).toBe('loaded')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await document.fonts.ready
  const started = pixelFaces().filter((face) => face.status !== 'unloaded')
  expect(started.map(label).sort()).toEqual(faces.map(label).sort())
}

describe('像素字体分片', () => {
  it('同一个字族里的 unicode-range 互不重叠', () => {
    const faces = [...fontsCss.matchAll(/font-family: '([^']+)';[^}]*unicode-range: ([^;]+);/g)]
    expect(faces.length).toBeGreaterThan(2)
    for (const family of [FAMILY, EXT_FAMILY]) {
      const ranges = faces
        .filter((face) => face[1] === family)
        .flatMap((face) => parseRanges(face[2]!))
        .sort((a, b) => a[0] - b[0])
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBeGreaterThan(ranges[i - 1]![1])
    }
  })

  // 已下载的分片在页面里累积，所以按顺序写在一个用例里
  it('按页面用到的字下载分片', async () => {
    const latin = faceFor(FAMILY, 'A')
    const han = faceFor(FAMILY, '皮')

    // 只有拉丁字母和数字时，不下载汉字
    await show('NextSkin 2026')
    await expectLoaded(latin)

    // 常用字、界面用到的二级字、行内符号都在主字族里
    await show('皮肤库 昵称 ♥ ★ ×')
    await expectLoaded(latin, han)

    // 生僻字：常用汉字那片没有字形，回退到补充字族里对应的那一片
    const rare = faceFor(EXT_FAMILY, '龘')
    await show('龘')
    await expectLoaded(latin, han, rare)

    // 不在主字族范围里的文字直接下载补充分片
    const hangul = faceFor(EXT_FAMILY, '한')
    await show('한')
    await expectLoaded(latin, han, rare, hangul)
  })
})
