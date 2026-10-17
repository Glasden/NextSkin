import { Field as BaseField } from '@base-ui/react/field'
import type { ReactNode } from 'react'

export interface FieldProps {
  label: ReactNode
  /** 填写说明，放在控件下方 */
  description?: ReactNode
  /**
   * 错误信息，写“发生了什么，加上怎么办”（DESIGN.md §8）。不传时，放在 Form 里的 Field 显示 Form 的 errors 里
   * 同名字段的错误，或者浏览器约束校验（required、type="email"……）的提示
   */
  error?: ReactNode
  disabled?: boolean
  name?: string
  /** 一个表单控件，例如 Input */
  children: ReactNode
}

const errorClass = 'text-sm text-danger'

/** 包裹表单控件，统一标签、说明和错误信息的位置，并把它们和控件关联起来（aria-describedby） */
export function Field({ label, description, error, disabled, name, children }: FieldProps) {
  return (
    <BaseField.Root
      name={name}
      disabled={disabled}
      // 有错误时强制无效；没有时交给 Form 和浏览器的约束校验
      invalid={error ? true : undefined}
      className="flex flex-col gap-2"
    >
      <BaseField.Label className="text-sm font-medium text-text data-disabled:text-text-muted">{label}</BaseField.Label>
      {children}
      {description && <BaseField.Description className="text-sm text-text-muted">{description}</BaseField.Description>}
      {error ? (
        <BaseField.Error match className={errorClass}>
          {error}
        </BaseField.Error>
      ) : (
        // 不能传 children（哪怕是 undefined），否则不显示 Form 和浏览器给的错误信息
        <BaseField.Error className={errorClass} />
      )}
    </BaseField.Root>
  )
}
