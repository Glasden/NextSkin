import type { Json } from './dto'

/**
 * 插件 UI 贡献。
 *
 * 默认全部是声明式的：插件只描述"要什么"，由核心用 @nextskin/ui 的组件渲染。
 * 这样插件界面自动继承站点的视觉语言、暗色模式和无障碍处理，插件也拿不到浏览器里的执行权。
 * 只有 `{ kind: 'component' }` 视图和验证码挂件会在浏览器里运行插件代码，需要 `ui.script` 能力。
 *
 * 设置页不需要在这里声明：核心根据 `settings` schema 自动生成，
 * 字段文案按约定取 `settings.<key>.label` 和 `settings.<key>.help`。
 */

/** 插件命名空间内的 i18n 键，对应插件 locales/<lang>.json 中的键。 */
export type MessageKey = string
/** pixelarticons 图标名，例如 'ticket'、'user'、'image'。 */
export type IconName = string
/** 插件路由路径，相对于 /plugins/{id}。可以用 `:field` 引用表格行的字段。 */
export type PluginPath = `/${string}`

/** 插件可以追加字段的核心表单。字段值通过拦截器/事件里的 `extra` 交给插件。 */
export type FormName = 'auth.register' | 'user.profile' | 'texture.upload'

/** 插件可以放置挂件的位置。 */
export type SlotName =
  | 'user.dashboard'
  | 'admin.dashboard'
  | 'user.profile.sections'
  | 'skinlib.detail.sidebar'
  | 'player.card.footer'

export interface Field {
  readonly name: string
  readonly label: MessageKey
  readonly type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'password'
  readonly required?: boolean
  readonly help?: MessageKey
  readonly placeholder?: MessageKey
  readonly maxLength?: number
  readonly options?: readonly { readonly value: string; readonly label: MessageKey }[]
}

export interface Column {
  readonly key: string
  readonly label: MessageKey
  /** 'user' / 'player' / 'texture'：值是对应的 id，核心渲染成带头像的链接 */
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

export interface ClientModuleRef {
  /** 插件包内已构建好的 ESM 路径 */
  readonly path: `./${string}`
  /** 默认 'default' */
  readonly export?: string
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
      /** GET 该路由得到初始值（Record<string, Json>） */
      readonly load?: PluginPath
      readonly submit: { readonly route: PluginPath; readonly method: 'POST' | 'PUT' | 'PATCH'; readonly label: MessageKey }
    }
  | {
      readonly kind: 'stats'
      /** GET 该路由，返回 StatsSourceResponse */
      readonly source: PluginPath
    }
  | {
      readonly kind: 'markdown'
      /** GET 该路由，返回 text/markdown；核心负责净化 */
      readonly source: PluginPath
    }
  | {
      /** 需要 `ui.script`。组件必须使用 @nextskin/ui 和设计 token。 */
      readonly kind: 'component'
      readonly module: ClientModuleRef
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
    /** pages 中的键 */
    readonly page: string
    readonly label: MessageKey
    readonly icon: IconName
  }[]
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
  readonly widgets?: readonly { readonly slot: SlotName; readonly title?: MessageKey; readonly view: View }[]
}
