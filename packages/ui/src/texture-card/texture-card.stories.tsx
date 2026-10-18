import type { Meta, StoryObj } from '@storybook/react-vite'
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js'
import { expect, userEvent } from 'storybook/test'
import { Badge } from '../badge/badge.tsx'
import { IconButton } from '../icon-button/icon-button.tsx'
import { fixture, type FixtureName } from '../skin-figure/fixtures.ts'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { TextureCard, type TextureCardProps } from './texture-card.tsx'

const meta = {
  title: 'Components/TextureCard',
  component: TextureCard,
  args: { name: '', figure: null },
} satisfies Meta<typeof TextureCard>

export default meta
type Story = StoryObj<typeof meta>

function card(
  name: string,
  texture: FixtureName,
  meta: string,
  extra: Partial<TextureCardProps> = {},
): { id: string; props: TextureCardProps } {
  return {
    id: texture,
    props: {
      name,
      href: `#${texture}`,
      figure: <SkinFigure {...fixture(texture)} scale={4} alt={`${name}（${meta.split(' · ')[0]}）`} />,
      meta,
      ...extra,
    },
  }
}

const library = [
  card('初音未来 · 樱花季', 'hatsune_miku', 'Alex · 128 人收藏', { selected: '已在衣柜' }),
  card('Haka', 'haka', 'Steve · 36 人收藏'),
  card('红金装甲（高清）', 'ironman_hd', 'Steve · 1024 人收藏'),
  card('旧版 64×32 的经典款，名字特别长也只占一行', 'sethbling', 'Steve · 2 人收藏'),
  card('Mojang 披风', 'mojang_cape', '披风 · 9 人收藏', { selected: '已在衣柜' }),
  card('我的私有草稿', 'default-skin', 'Alex · 1 人收藏', { badge: <Badge>私有</Badge> }),
]

/** 皮肤库的网格：已在衣柜的卡片有强调色的边框和勾选角标；自己的私有材质名字后面有“私有” */
export const Library: Story = {
  render: () => (
    <div className="grid w-200 grid-cols-4 gap-4">
      {library.map(({ id, props }) => (
        <TextureCard key={id} {...props} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(
      library.map((item) => item.props.name),
    )
    // 整张卡片是一个链接，勾选角标的说明也在链接的名字里
    const miku = canvas.getByRole('link', { name: /初音未来 · 樱花季/ })
    await expect(miku).toHaveAttribute('href', '#hatsune_miku')
    await expect(miku).toHaveAccessibleName(/已在衣柜/)
    await expect(canvas.getByRole('link', { name: /^Haka/ })).not.toHaveAccessibleName(/已在衣柜/)
  },
}

/** 键盘聚焦：显示焦点框，皮肤转身 */
export const Focused: Story = {
  render: () => (
    <div className="w-48">
      <TextureCard {...card('Haka', 'haka', 'Steve · 36 人收藏').props} />
    </div>
  ),
  play: async ({ canvas }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('link')).toHaveFocus()
  },
}

/** 衣柜里的卡片：右上角有“更多”，点它不会跳转 */
export const WithActions: Story = {
  render: () => (
    <div className="grid w-100 grid-cols-2 gap-4">
      {[card('上学穿', 'hatsune_miku', 'Alex'), card('冬天的披风', 'legacy_cape', '披风')].map(({ id, props }) => (
        <TextureCard
          key={id}
          {...props}
          headingLevel="h3"
          actions={
            <IconButton size="sm" label={`${props.name}的更多操作`}>
              <MoreVertical />
            </IconButton>
          }
        />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    const more = canvas.getByRole('button', { name: '上学穿的更多操作' })
    await expect(canvas.getByRole('link', { name: /上学穿/ })).not.toContainElement(more)
  },
}
