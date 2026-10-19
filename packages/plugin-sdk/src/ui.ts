import type { Json } from './dto.ts'

/**
 * 插件 UI 贡献。
 *
 * 全部是声明式的：插件只描述"要什么"，由核心用 @nextskin/ui 的组件渲染。
 * 这样插件界面自动继承站点的视觉语言、暗色模式和无障碍处理，插件也拿不到浏览器里的执行权。
 *
 * 插件的名字和简介显示在后台的插件页，按约定取文案键 `plugin.name`、`plugin.description`；没写名字就显示 id。
 *
 * 设置页不需要在这里声明：核心根据 `settings` schema 自动生成（ADR-0028）。字段文案按约定取：
 * - `settings.<key>.label`、`settings.<key>.help`；
 * - 对象的属性：`settings.<key>.fields.<属性>.label`、`settings.<key>.fields.<属性>.help`；
 * - 枚举的选项：`settings.<key>.options.<值>`。
 */

/** 插件命名空间内的 i18n 键，对应插件 locales/<lang>.json 中的键。 */
export type MessageKey = string
/** pixelarticons 的图标名（SVG 的文件名，kebab-case），例如 'mail'、'user'、'cloud-server'；认不出来的显示成积木。 */
export type IconName = string
/** 插件路由路径，相对于 `/plugins/{id}`。允许查询参数；禁止 .、..、空段、反斜杠和 #。
 * `:field` 只接受字符串或有限数字，不能为 . 或 ..，非法值会让操作失败并提示。 */
export type PluginPath = `/${string}`

/** 插件可以追加字段的核心表单。字段值通过拦截器和事件里的 `extra` 交给插件。 */
export type FormName = 'auth.register'

interface FieldBase {
  /** 注册字段名为 `[A-Za-z][A-Za-z0-9]{0,31}`，同一插件内不能重复。 */
  readonly name: string
  readonly label: MessageKey
  readonly required?: boolean
  readonly help?: MessageKey
}

export type Field = FieldBase &
  (
    | {
        readonly type: 'text' | 'textarea' | 'password'
        readonly placeholder?: MessageKey
        readonly maxLength?: number
      }
    | { readonly type: 'number'; readonly placeholder?: MessageKey }
    | {
        readonly type: 'select'
        readonly options: readonly [
          { readonly value: string; readonly label: MessageKey },
          ...{ readonly value: string; readonly label: MessageKey }[],
        ]
      }
    | { readonly type: 'boolean' }
  )

export interface Column {
  readonly key: string
  readonly label: MessageKey
  /** 值是对应 id：user 显示头像和昵称（仅后台带用户链接）；player 只显示名字；texture 显示 #tid 链接 */
  readonly format?: 'text' | 'code' | 'number' | 'datetime' | 'boolean' | 'status' | 'user' | 'player' | 'texture'
}

export interface Action {
  readonly label: MessageKey
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly route: PluginPath
  readonly tone?: 'default' | 'danger'
  /** 有值时先弹确认框；tone 为 danger 时强烈建议提供 */
  readonly confirm?: MessageKey
  /** 有值时先弹表单，提交的 JSON 作为请求体 */
  readonly form?: readonly Field[]
}

export type View =
  | {
      readonly kind: 'table'
      /** GET 该路由，返回 TableSourceResponse；带 ?page=&pageSize=&q= */
      readonly source: PluginPath
      readonly columns: readonly Column[]
      readonly searchable?: boolean
      readonly toolbar?: readonly Action[]
      readonly rowActions?: readonly Action[]
    }
  | {
      readonly kind: 'form'
      readonly fields: readonly Field[]
      /** GET 该路由得到初始值（`Record<string, Json>`） */
      readonly load?: PluginPath
      readonly submit: {
        readonly route: PluginPath
        readonly method: 'POST' | 'PUT' | 'PATCH'
        readonly label: MessageKey
      }
    }
  | {
      readonly kind: 'stats'
      /** GET 该路由，返回 StatsSourceResponse */
      readonly source: PluginPath
    }
  | {
      readonly kind: 'markdown'
      /** GET 该路由，返回 text/markdown；不渲染原始 HTML（ADR-0028） */
      readonly source: PluginPath
    }

export interface TableSourceResponse {
  readonly rows: readonly Readonly<Record<string, Json>>[]
  readonly total: number
}

export interface StatsSourceResponse {
  readonly items: readonly { readonly label: MessageKey; readonly value: number | string }[]
}

export interface UiContributions<P> {
  readonly nav?: readonly {
    readonly area: 'user' | 'admin'
    /** pages 中的键，必须存在且 area 相同。 */
    readonly page: string
    readonly label: MessageKey
    readonly icon: IconName
  }[]
  /** 页面名为 `[a-z][a-z0-9-]{0,63}`。 */
  readonly pages?: Readonly<
    Record<
      string,
      {
        readonly area: 'user' | 'admin'
        readonly title: MessageKey
        /** admin 区域的页面默认要求管理员；有值时改为要求该插件权限 */
        readonly permission?: NoInfer<keyof P & string>
        readonly view: View
      }
    >
  >
  readonly formFields?: readonly { readonly form: FormName; readonly field: Field }[]
}
