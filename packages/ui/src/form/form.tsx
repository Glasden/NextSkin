import { Form as BaseForm } from '@base-ui/react/form'

export type FormProps = Omit<BaseForm.Props, 'className' | 'style' | 'render'>

/**
 * 表单。提交时先做浏览器的约束校验（required、type="email"……），把提示显示在对应的 Field 下方，并聚焦第一个不通过的控件；
 * 服务端返回的错误按字段名传给 errors，字段值一改就清掉。子元素纵向排列，间距 16px。
 * 默认 method="post"：页面水合之前提交时，浏览器按原生表单提交，GET 会把密码这类字段放进地址栏、浏览器历史和反向代理的访问日志；
 * POST 只是把页面重新打开一次。水合之后 onFormSubmit 会阻止原生提交，method 不起作用
 */
export function Form(props: FormProps) {
  return <BaseForm method="post" {...props} className="flex flex-col gap-4" />
}
