import type { TextureType } from '@nextskin/skin'
import figure from '@nextskin/skin/assets/figures/default-skin-k1.png'
import figures from '@nextskin/skin/assets/figures/manifest.json'
import { Logo, SkinFigure, Stage } from '@nextskin/ui'
import { getTranslations } from 'next-intl/server'
import NextLink from 'next/link'
import type { ReactNode } from 'react'
import { getServer } from '../../lib/server'
import { ColorModeMenu } from '../color-mode-menu'

// 默认皮肤只有 k = 1 一种分辨率（64×64 的材质），预先渲染好随核心发布（packages/skin/assets）。
// 材质的出图路由落地后，插图可以换成站点里的材质
const defaultSkin = {
  type: figures.figures['default-skin'].type as TextureType,
  textureScale: figures.figures['default-skin'].textureScale,
  src: () => figure.src,
}
const DEFAULT_SKIN_OWNER = 'cxchency'

/** 认证页默认的插图：展台上的默认皮肤，下面一行注明作者 */
export async function DefaultIllustration({ scale }: { readonly scale: 4 | 8 }) {
  const t = await getTranslations('auth')
  const caption = t('illustration', { name: DEFAULT_SKIN_OWNER })
  return (
    <figure className="flex flex-col items-center gap-6">
      <SkinFigure {...defaultSkin} scale={scale} alt={caption} turnOnHover loading="eager" />
      {/* 图片的替代文字已经是同一句话，读屏软件不再重复读说明 */}
      <figcaption aria-hidden className="text-sm text-text-muted">
        {caption}
      </figcaption>
    </figure>
  )
}

/**
 * 认证页的框架：左边是表单，右边是展台（DESIGN.md §2.2）。移动端展台缩小放在表单上方。
 * 登录、注册、找回密码用默认的插图；启动器授权页（/device）换成所选角色
 */
export async function AuthShell({
  children,
  illustration = (scale) => <DefaultIllustration scale={scale} />,
}: {
  readonly children: ReactNode
  /** 展台上的内容：窄屏 ×4、宽屏 ×8 */
  readonly illustration?: (scale: 4 | 8) => ReactNode
}) {
  const { core } = await getServer()
  const { 'site.name': siteName } = await core.settings.read(['site.name'])
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-4 py-6 sm:px-8">
        <header className="flex items-center justify-between gap-4">
          <Logo name={siteName} render={<NextLink href="/" />} />
          <ColorModeMenu />
        </header>
        <div className="mt-6 h-56 lg:hidden">
          <Stage grid>{illustration(4)}</Stage>
        </div>
        <main className="flex flex-1 flex-col py-8 lg:justify-center lg:py-10">
          <div className="mx-auto w-full max-w-sm">{children}</div>
        </main>
      </div>
      <aside className="hidden p-4 lg:block">
        <Stage grid>{illustration(8)}</Stage>
      </aside>
    </div>
  )
}
