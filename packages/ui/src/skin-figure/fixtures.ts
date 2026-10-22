import type { PoseView, TextureType } from '@nextskin/skin'
import { expect, waitFor } from 'storybook/test'
import manifest from './fixtures/manifest.json'

// story 用的拼图和头像，由 scripts/skin-fixtures.ts 生成。只给 story 用，不从包里导出
const urls = import.meta.glob<string>('./fixtures/*.png', { eager: true, query: '?url', import: 'default' })

export type FixtureName = keyof typeof manifest.figures

/**
 * 返回 SkinFigure 需要的 src、type 和 textureScale。3D 出图只有 story 用到的 1x（scripts/skin-fixtures.ts）：
 * 2x 的地址退回 1x；没人悬浮的人物没有抬手拼图，退回同一视角的另一张拼图，只为让 src 有个地址
 */
export function fixture(name: FixtureName) {
  const { type, textureScale } = manifest.figures[name]
  return {
    type: type as TextureType,
    textureScale,
    src: (n: number, view: PoseView, raise: boolean) => {
      const prefix = type === 'cape' ? `./fixtures/${name}-k` : `./fixtures/${name}-${view}${raise ? '-raise' : ''}-p`
      const url =
        urls[`${prefix}${n}.png`] ??
        (n % 2 === 0 ? urls[`${prefix}${n / 2}.png`] : undefined) ??
        (raise ? Object.entries(urls).find(([file]) => file.startsWith(prefix))?.[1] : undefined)
      if (!url) throw new Error(`没有 ${prefix}${n}.png，运行 pnpm --filter @nextskin/ui skin:fixtures`)
      return url
    },
  }
}

/** 返回 PlayerHead 需要的 src 和 textureScale；披风没有头像 */
export function headFixture(name: Exclude<FixtureName, 'mojang_cape' | 'legacy_cape'>) {
  const { textureScale } = manifest.figures[name]
  return {
    textureScale,
    src: (k: number) => {
      const url = urls[`./fixtures/${name}-head-k${k}.png`]
      if (!url) throw new Error(`没有 ${name} 在 k = ${k} 的头像，运行 pnpm --filter @nextskin/ui skin:fixtures`)
      return url
    },
  }
}

export const fixtureRendererVersion = manifest.rendererVersion

/**
 * 等图片下载、解码的 waitFor 用的上限。默认的 1 秒在 CI 上不够：check 并行跑整套测试时，
 * 抬手拼图下载完再 decode() 偶尔要一秒多，story 就超时失败
 */
export const IMAGE_TIMEOUT = 5000

/** 等抬手拼图下载、解码完：play 里悬浮或聚焦过人物以后调用，截图才稳定 */
export async function raiseSettled(root: HTMLElement) {
  await waitFor(() => expect(root.querySelectorAll('img[data-raise]:not([data-ready])')).toHaveLength(0), {
    timeout: IMAGE_TIMEOUT,
  })
}
