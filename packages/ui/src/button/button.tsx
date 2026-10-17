import { Button as BaseButton } from '@base-ui/react/button'
import { cx } from '../cx.ts'

export interface ButtonProps extends Omit<
  BaseButton.Props,
  'className' | 'style' | 'render' | 'nativeButton' | 'focusableWhenDisabled'
> {
  /** primary 每个视图最多一个；danger 只用于不可逆操作。跳转到其他页面用 Link（DESIGN.md §6） */
  variant?: 'primary' | 'secondary' | 'danger'
  /** 高 32 / 40 / 48px：后台密集场景、默认、前台的主要操作 */
  size?: 'sm' | 'md' | 'lg'
  /** 提交中：保持按下的样子并显示加载动画，不响应点击，但焦点留在按钮上（DESIGN.md §7） */
  loading?: boolean
  /** 占满容器宽度，用于移动端的表单。按钮不接受 className：外观只有这几种，间距由父元素负责 */
  fullWidth?: boolean
}

const base = cx(
  'relative inline-flex shrink-0 items-center justify-center rounded-sm border font-sans font-medium whitespace-nowrap select-none',
  'transition-[background-color,translate,box-shadow] duration-fast ease-step motion-reduce:transition-none',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  // 移动端把点击区域扩到 44px（DESIGN.md §9）
  'pointer-coarse:after:absolute pointer-coarse:after:inset-x-0',
)

const sizes = {
  sm: 'h-8 px-3 text-sm pointer-coarse:after:-inset-y-1.5',
  md: 'h-10 px-4 text-base pointer-coarse:after:-inset-y-0.5',
  lg: 'h-12 px-6 text-base',
}

// 底色放进 --button-bg，悬停时统一混入 12% 的 text：亮色下变深、暗色下变亮
const variants = {
  primary: '[--button-bg:var(--color-accent)] border-transparent text-accent-fg',
  secondary: '[--button-bg:var(--color-surface)] border-border-strong text-text',
  danger: '[--button-bg:var(--color-danger)] border-transparent text-danger-fg',
}

const raised = 'bg-(--button-bg) shadow-pixel'
// 按下：下沉 2px，阴影消失（DESIGN.md §2）
const pressed = 'translate-x-0.5 translate-y-0.5 shadow-none'
const interactive = cx(
  'hover:bg-[color-mix(in_srgb,var(--button-bg)_88%,var(--color-text))]',
  'active:translate-x-0.5 active:translate-y-0.5 active:shadow-none',
)
const disabledLook = 'cursor-not-allowed border-border bg-surface-sunken text-text-muted'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled = false,
  children,
  ...props
}: ButtonProps) {
  const state = loading
    ? cx(variants[variant], 'bg-(--button-bg) cursor-progress', pressed)
    : disabled
      ? disabledLook
      : cx(variants[variant], raised, interactive)

  return (
    <BaseButton
      {...props}
      // 加载中用 aria-disabled 而不是 disabled：焦点不丢，键盘用户还停在原处
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cx(base, sizes[size], state, fullWidth && 'w-full')}
    >
      {/* 加载时文字只是透明，宽度不变，仍是按钮的可访问名称 */}
      <span className={cx('inline-flex items-center gap-2', loading && 'opacity-0')}>{children}</span>
      {loading && <LoadingDots />}
    </BaseButton>
  )
}

/** 三个方块依次亮起；减少动态效果时静止 */
function LoadingDots() {
  return (
    <span aria-hidden className="absolute inset-0 flex items-center justify-center gap-1">
      {['0ms', '-600ms', '-300ms'].map((delay) => (
        <span
          key={delay}
          className="size-1 bg-current animate-loading motion-reduce:animate-none"
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  )
}
