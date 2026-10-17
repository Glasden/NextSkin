import { Input as BaseInput } from '@base-ui/react/input'
import { cx } from '../cx.ts'
import { focusRing } from '../styles.ts'

export interface InputProps extends Omit<BaseInput.Props, 'className' | 'style' | 'render' | 'size'> {
  /** 高 32 / 40 / 48px，和同一行的 Button 取相同的尺寸 */
  size?: 'sm' | 'md' | 'lg'
}

const sizes = {
  sm: 'h-8 px-2 text-sm',
  md: 'h-10 px-3 text-base',
  lg: 'h-12 px-4 text-base',
}

/** 单行文本输入框。放在 Field 里使用，标签、说明和错误信息由 Field 负责；宽度占满父元素 */
export function Input({ size = 'md', ...props }: InputProps) {
  return (
    <BaseInput
      {...props}
      // 禁用可能来自外层的 Field，所以按 Base UI 设的 data-disabled 取样式，不看 props
      className={cx(
        'w-full min-w-0 rounded-sm border border-border-strong bg-surface font-sans text-text placeholder:text-text-muted',
        'data-invalid:border-danger',
        'data-disabled:cursor-not-allowed data-disabled:border-border data-disabled:bg-surface-sunken data-disabled:text-text-muted',
        focusRing,
        sizes[size],
      )}
    />
  )
}
