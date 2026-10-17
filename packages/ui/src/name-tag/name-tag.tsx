export interface NameTagProps {
  /** 角色名。用户产生的内容，用正文字体（DESIGN.md §4） */
  children: string
}

/**
 * 站在展台上的角色头顶的名牌，与游戏里的名牌相同：深色底、浅色字（DESIGN.md §2.2）。
 * 太长时截断，宽度不超过父元素
 */
export function NameTag({ children }: NameTagProps) {
  return (
    <span className="inline-block max-w-full truncate bg-text px-1.5 py-0.5 align-bottom font-sans text-xs text-text-inverse">
      {children}
    </span>
  )
}
