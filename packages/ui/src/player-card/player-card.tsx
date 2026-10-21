import type { ReactNode } from 'react'

export interface PlayerCardProps {
  /** 角色名。用户产生的内容，用正文字体（DESIGN.md §4） */
  name: string
  /** 标题的层级，按页面的标题结构选 */
  headingLevel?: 'h2' | 'h3'
  /** 展台上的人物：×4 的 SkinFigure，还没有皮肤时用 FigurePlaceholder */
  figure: ReactNode
  /** 名字下面的信息，例如 UUID、更新时间；每项一行 */
  children?: ReactNode
  /** 底部的操作，例如“改名”“删除”的 Button */
  actions?: ReactNode
}

/**
 * 角色管理里的一个角色：上面是展台，下面是名字、信息和操作。鼠标移到卡片上时，展台上的皮肤抬手。
 * 材质用 TextureCard，账号用 PlayerHead 加昵称
 */
export function PlayerCard({ name, headingLevel: Heading = 'h2', figure, children, actions }: PlayerCardProps) {
  return (
    <article className="group/raise flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <div className="grid h-44 place-items-center border-b border-border bg-stage">{figure}</div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <Heading className="truncate text-xl font-medium text-text">{name}</Heading>
        {children && <div className="flex min-w-0 flex-col gap-1 text-sm text-text-muted">{children}</div>}
        {actions && <div className="mt-auto flex flex-wrap gap-2 pt-1">{actions}</div>}
      </div>
    </article>
  )
}
