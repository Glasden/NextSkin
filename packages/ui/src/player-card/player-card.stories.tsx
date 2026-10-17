import type { Meta, StoryObj } from '@storybook/react-vite'
import { Copy } from 'pixelarticons/react/Copy.js'
import { expect } from 'storybook/test'
import { Button } from '../button/button.tsx'
import { FigurePlaceholder } from '../figure-placeholder/figure-placeholder.tsx'
import { IconButton } from '../icon-button/icon-button.tsx'
import { fixture } from '../skin-figure/fixtures.ts'
import { SkinFigure } from '../skin-figure/skin-figure.tsx'
import { PlayerCard, type PlayerCardProps } from './player-card.tsx'

const meta = {
  title: 'Components/PlayerCard',
  component: PlayerCard,
  args: { name: '', figure: null },
} satisfies Meta<typeof PlayerCard>

export default meta
type Story = StoryObj<typeof meta>

function Details({ uuid, updated }: { uuid: string; updated: string }) {
  return (
    <>
      <div className="flex min-w-0 items-start gap-1">
        <code className="min-w-0 pt-2 font-mono text-xs break-all text-text">{uuid}</code>
        <IconButton label="复制 UUID" size="sm">
          <Copy />
        </IconButton>
      </div>
      <p>{updated}</p>
    </>
  )
}

const actions = (
  <>
    <Button size="sm">改名</Button>
    <Button size="sm">删除</Button>
  </>
)

const cards: PlayerCardProps[] = [
  {
    name: 'Hatsune_Miku',
    figure: <SkinFigure {...fixture('hatsune_miku')} scale={4} alt="Hatsune_Miku 的皮肤" />,
    children: <Details uuid="0b1a26b4-c02e-3a6b-8e9d-64f1a7a3c9d2" updated="更新于 2026-10-16 21:04" />,
    actions,
  },
  {
    name: 'Steve',
    figure: <FigurePlaceholder scale={4} label="Steve 还没有皮肤" />,
    children: (
      <>
        <Details uuid="5627dd98-e6be-3c21-b8a8-e92344183641" updated="更新于 2026-10-18 09:30" />
        <p>还没有皮肤，游戏里显示默认皮肤</p>
      </>
    ),
    actions,
  },
  {
    name: 'A_very_long_name_x',
    figure: <FigurePlaceholder scale={4} label="A_very_long_name_x 还没有皮肤" />,
    children: <Details uuid="9c2e1b0f-4d7a-3e5c-8b6a-1f2d3e4c5b6a" updated="更新于 2026-10-18 09:31" />,
  },
]

/** 角色管理页的卡片网格：有皮肤的、还没有皮肤的、名字很长的。删除按钮只打开确认框，所以不用 danger */
export const Grid: Story = {
  render: () => (
    <div className="grid w-200 grid-cols-3 gap-4">
      {cards.map((card) => (
        <PlayerCard key={card.name} {...card} />
      ))}
    </div>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(
      cards.map((card) => card.name),
    )
    await expect(canvas.getByRole('img', { name: 'Steve 还没有皮肤' })).toBeVisible()
  },
}
