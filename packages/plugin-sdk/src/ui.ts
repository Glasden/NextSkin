import type { Json } from './dto.ts'

/**
 * 插件 UI 贡献。
 *
 * 全部是声明式的：插件只描述"要什么"，由核心用 @nextskin/ui 的组件渲染。
 * 这样插件界面自动继承站点的视觉语言、暗色模式和无障碍处理，插件也拿不到浏览器里的执行权。
 * 配色主题也只交数据：在 `themes` 里声明要改的颜色和结构，由核心检查并生成 CSS，不需要能力。
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

/**
 * 核心注册表单的附加字段。
 * fromQuery 为 true 时，打开 `/sign-up` 用查询参数 `<插件 id>.<字段名>` 作初始值，用户看得到、改得了，提交后照常校验。
 * 只允许 text、textarea、number、select；第三方登录的“完成注册”页没有初始值。
 */
export type FormFieldContribution = { readonly form: FormName } & (
  | { readonly field: Field; readonly fromQuery?: false }
  | {
      readonly field: Field & { readonly type: 'text' | 'textarea' | 'number' | 'select' }
      readonly fromQuery: boolean
    }
)

export interface Column {
  readonly key: string
  readonly label: MessageKey
  /** 值是对应 id：user 显示头像和昵称（仅后台带用户链接）；player 只显示名字；texture 显示 #tid 链接 */
  readonly format?: 'text' | 'code' | 'number' | 'datetime' | 'boolean' | 'status' | 'user' | 'player' | 'texture'
}

/** 浏览器发动作请求时不跟随重定向：路由回 3xx 按失败显示 */
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

/**
 * 主题能改的颜色，和核心 theme.css 里的 `--color-*` 同名（不带前缀）。它们是公开 API：改名或删除是大版本。
 * `accent` 是画在表面上的强调色；`accent-fill` 是主要按钮这类色块，没写时跟着 `accent`，
 * `accent-fill-fg` 没写时跟着 `accent-fg`。
 * 展台 `stage` 和透明区域的棋盘格 `checker-a`、`checker-b` 锁住，在任何主题下都取默认值（ADR-0057）
 */
export type ThemeColor =
  | 'bg'
  | 'surface'
  | 'surface-raised'
  | 'surface-sunken'
  | 'border'
  | 'border-strong'
  | 'text'
  | 'text-muted'
  | 'text-inverse'
  | 'accent'
  | 'accent-fg'
  | 'accent-subtle'
  | 'accent-fill'
  | 'accent-fill-fg'
  | 'success'
  | 'success-fg'
  | 'warning'
  | 'warning-fg'
  | 'danger'
  | 'danger-fg'
  | 'focus'
  | 'shadow'

/** `#rrggbb`，不分大小写 */
export type ThemeColorValue = `#${string}`

/**
 * 主题结构：每项可省略，省略的取钻石青；亮暗共用一份。
 * 插件交的是枚举，CSS 变量名不是插件 API（ADR-0058）
 */
export interface ThemeStructure {
  /** 默认 rounded；square 时 2px、4px 圆角都变直角 */
  readonly radius?: 'rounded' | 'square'
  /** 默认 thin；thick 时常规边框从 1px 变 2px，选中框从 2px 变 4px */
  readonly borders?: 'thin' | 'thick'
  /** 默认 flat；raised 时面板和卡片静止带 4px 硬边阴影 */
  readonly cards?: 'flat' | 'raised'
}

/**
 * 一套配色主题：只是数据，核心检查对比度后生成 CSS。主题 id 是 `<插件 id>/<name>`。
 * 只写要改的颜色：没写的 `focus` 跟着 `accent`，`accent-subtle` 由 `accent` 混入 `surface` 得到，`accent-fill`、`accent-fill-fg` 跟着 `accent`、`accent-fg`，其余取默认主题钻石青。
 * 结构只选枚举，不交 CSS，没写的项取钻石青
 */
export interface ThemeContribution {
  /** `[a-z][a-z0-9]*(-[a-z0-9]+)*`，最多 32 个字符，同一插件内不重复；一个插件最多 16 套 */
  readonly name: string
  /** 主题名的文案键，例如 `themes.cobalt` */
  readonly label: MessageKey
  /** 圆角、边框和卡片的结构，不分亮暗，每项可省略 */
  readonly structure?: ThemeStructure
  /** 亮色、暗色下要改的颜色，都可以省略 */
  readonly colors: {
    readonly light?: Readonly<Partial<Record<ThemeColor, ThemeColorValue>>>
    readonly dark?: Readonly<Partial<Record<ThemeColor, ThemeColorValue>>>
  }
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
  readonly formFields?: readonly FormFieldContribution[]
  /** 配色主题：新带来的主题默认不启用，由超级管理员在后台的主题页启用（ADR-0057） */
  readonly themes?: readonly ThemeContribution[]
}
