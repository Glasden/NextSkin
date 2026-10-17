import { Form as BaseForm } from '@base-ui/react/form'

export type FormProps = Omit<BaseForm.Props, 'className' | 'style' | 'render'>

/**
 * 表单。提交时先做浏览器的约束校验（required、type="email"……），把提示显示在对应的 Field 下方，并聚焦第一个不通过的控件；
 * 服务端返回的错误按字段名传给 errors，字段值一改就清掉。子元素纵向排列，间距 16px
 */
export function Form(props: FormProps) {
  return <BaseForm {...props} className="flex flex-col gap-4" />
}
