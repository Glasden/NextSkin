import { cx } from '../cx.ts'

export interface PasswordMeterProps {
  /** 强度档位：0 弱、1 一般、2 强、3 很强。空字符串（还没有输入）传 null，不显示 */
  level: 0 | 1 | 2 | 3 | null
  /** 档位文字，例如“弱”。显示在方块后面，和方块一起读给读屏软件 */
  label: string
  /** 读给读屏软件的完整说法，例如“密码强度：弱”：只读档位会被读成孤零零的“弱” */
  ariaLabel: string
}

/** 四格固定，点亮的数量就是档位 */
const LEVELS = 4

/** 好的状态用 success，不用 accent：配色主题会换掉 accent，强弱不该跟着主题变（DESIGN.md §9） */
const tones = ['bg-danger', 'bg-warning', 'bg-success', 'bg-success']

/**
 * 密码强度指示：一排四个方块，点亮的数量和颜色说明强度。只是指示，不参与校验：
 * 密码的合法性只有长度边界（password-policy.ts），弱密码也能提交。
 * 从 ProgressBar 借来的方块语言；颜色语义同 Badge（DESIGN.md §9）
 */
export function PasswordMeter({ level, label, ariaLabel }: PasswordMeterProps) {
  if (level === null) return null
  return (
    <div role="status" aria-label={ariaLabel} className="flex items-center gap-2">
      <div aria-hidden className="flex gap-0.5">
        {Array.from({ length: LEVELS }, (_, index) => (
          <span key={index} className={cx('h-1.5 w-4 rounded-none', index <= level ? tones[level] : 'bg-border')} />
        ))}
      </div>
      <span className="text-sm text-text-muted">{label}</span>
    </div>
  )
}
