import type { TextureSummary } from '@nextskin/domain'
import { Badge, SkinFigure, TextureCard } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import { figureSrc } from '../../lib/textures'

/** 皮肤库网格里的一件材质，首页的“最新上传”也用它；已在自己衣柜里的显示为选中（ADR-0025） */
export async function LibraryCard({ texture, headingLevel }: { texture: TextureSummary; headingLevel?: 'h2' | 'h3' }) {
  const t = await getTranslations('skinlib')
  const type = t(`types.${texture.type}`)
  return (
    <TextureCard
      render={<NextLink href={`/skinlib/${texture.tid}`} />}
      name={texture.name}
      headingLevel={headingLevel}
      figure={
        <SkinFigure
          src={figureSrc(texture.hash, texture.type)}
          type={texture.type}
          textureScale={texture.scale}
          scale={4}
          alt={t('figureAlt', { name: texture.name, type })}
        />
      }
      meta={t('list.meta', { type, likes: texture.likes })}
      badge={texture.public ? undefined : <Badge>{t('private')}</Badge>}
      selected={texture.inCloset ? t('inCloset') : undefined}
    />
  )
}
