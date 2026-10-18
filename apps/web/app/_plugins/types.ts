// 服务端组件把插件声明的字段和操作翻译好再交给客户端组件：插件的文案在核心进程里，浏览器拿不到

/** 一个表单字段（SDK 的 Field），标签、说明、占位符和选项都已经翻译好 */
export interface PluginFieldText {
  name: string
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'password'
  label: string
  help?: string
  placeholder?: string
  required?: boolean
  maxLength?: number
  options?: readonly { value: string; label: string }[]
}

/** 一个操作（SDK 的 Action）：按钮文字、确认的说明、表单都已经翻译好 */
export interface PluginActionText {
  label: string
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  route: `/${string}`
  tone: 'default' | 'danger'
  confirm?: string
  form?: readonly PluginFieldText[]
}
