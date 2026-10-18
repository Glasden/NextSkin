import type { TextureType } from '@nextskin/skin'
import manifest from './fixtures/manifest.json'

// story 用的拼图和头像，由 scripts/skin-fixtures.ts 生成。只给 story 用，不从包里导出
const urls = import.meta.glob<string>('./fixtures/*.png', { eager: true, query: '?url', import: 'default' })

export type FixtureName = keyof typeof manifest.figures

/** 返回 SkinFigure 需要的 src、type 和 textureScale */
export function fixture(name: FixtureName) {
  const { type, textureScale } = manifest.figures[name]
  return {
    type: type as TextureType,
    textureScale,
    src: (k: number) => {
      const url = urls[`./fixtures/${name}-k${k}.png`]
      if (!url) throw new Error(`没有 ${name} 在 k = ${k} 的拼图，运行 pnpm --filter @nextskin/ui skin:fixtures`)
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
