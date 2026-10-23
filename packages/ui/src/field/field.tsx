'use client'

import { Field as BaseField } from '@base-ui/react/field'
import type { ReactNode } from 'react'
import { useValidationMessages, type ValidationMessages } from './validation-messages.tsx'

export interface FieldProps {
  label: ReactNode
  /** 填写说明，放在控件下方 */
  description?: ReactNode
  /**
   * 错误信息，写“发生了什么，加上怎么办”（DESIGN.md §8）。不传时，放在 Form 里的 Field 显示 Form 的 errors 里
   * 同名字段的错误；没填就提交（required）和其他浏览器约束校验的提示也显示在这里
   */
  error?: ReactNode
  /**
   * 内容格式不对（type="email"、type="url"、pattern）时的提示，写清楚该输入什么。
   * 不传时用 ValidationMessages 里的通用说法：Field 看不到控件是什么类型，具体格式只有调用点知道
   */
  formatError?: ReactNode
  disabled?: boolean
  name?: string
  /**
   * 控件是一个按钮（例如 Select）时设为 false：标签渲染成 div，点标签只聚焦控件，不会像原生 label 那样把点击转给按钮
   * （Base UI 的 nativeLabel）
   */
  nativeLabel?: boolean
  /** 一个表单控件，例如 Input */
  children: ReactNode
}

const errorClass = 'text-sm text-danger'

/** 包裹表单控件，统一标签、说明和错误信息的位置，并把它们和控件关联起来（aria-describedby） */
export function Field({
  label,
  description,
  error,
  formatError,
  disabled,
  name,
  nativeLabel = true,
  children,
}: FieldProps) {
  // 提示文案由 ValidationMessagesProvider 按站点语言统一给，调用点不用管；没有 Provider 时用浏览器给的消息
  const messages = useValidationMessages()
  // 不能传 children（哪怕是 undefined），否则不显示 Form 和浏览器给的错误信息
  const browserError = <BaseField.Error className={errorClass} />
  return (
    <BaseField.Root
      name={name}
      disabled={disabled}
      // 有错误时强制无效；没有时交给 Form 和浏览器的约束校验
      invalid={error ? true : undefined}
      className="flex flex-col gap-2"
    >
      <BaseField.Label
        className="text-sm font-medium text-text data-disabled:text-text-muted"
        nativeLabel={nativeLabel}
        render={nativeLabel ? undefined : <div />}
      >
        {label}
      </BaseField.Label>
      {children}
      {description && <BaseField.Description className="text-sm text-text-muted">{description}</BaseField.Description>}
      {error ? (
        <BaseField.Error match className={errorClass}>
          {error}
        </BaseField.Error>
      ) : messages ? (
        // 认识的约束换成站点文案；不认识的（tooLong、badInput 这些在界面上到不了）仍然用浏览器的
        <BaseField.Validity>
          {({ validity }) => {
            const message = validityMessage(validity, messages, formatError)
            return message ? (
              <BaseField.Error match className={errorClass}>
                {message}
              </BaseField.Error>
            ) : (
              browserError
            )
          }}
        </BaseField.Validity>
      ) : (
        browserError
      )}
    </BaseField.Root>
  )
}

/** Base UI 报上来的约束状态（不是 DOM 的 ValidityState，多一个 valid） */
interface Validity {
  valueMissing: boolean
  typeMismatch: boolean
  patternMismatch: boolean
  tooShort: boolean
  rangeUnderflow: boolean
  rangeOverflow: boolean
  stepMismatch: boolean
}

/** 当前该显示哪一条，按用户撞上的先后排：没填、格式、太短、超出范围 */
function validityMessage(validity: Validity, messages: ValidationMessages, formatError: ReactNode): ReactNode | null {
  if (validity.valueMissing) return messages.required
  if (validity.typeMismatch || validity.patternMismatch) return formatError ?? messages.format
  if (validity.tooShort) return messages.tooShort
  if (validity.rangeUnderflow || validity.rangeOverflow || validity.stepMismatch) return messages.range
  return null
}
