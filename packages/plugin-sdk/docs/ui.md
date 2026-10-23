# 界面

第一版只有声明式 UI：你描述导航、表格、表单、统计或 Markdown，核心负责渲染。不能提交运行时 React 组件、浏览器脚本或往核心页面注入 HTML。

## 导航和页面

`ui.pages` 的键匹配 `^[a-z][a-z0-9-]{0,63}$`。每页有 area（user 或 admin）、title（文案键）、可选 permission、view。页面在 `/user/plugins/{id}/{页面名}` 或 `/admin/plugins/{id}/{页面名}`。user 区要求登录；admin 区默认要求管理员，声明 permission 则要求该插件权限。第一版所有插件权限只给管理员和超级管理员。

`ui.nav` 的每项有 area、page、label、icon。page 必须存在且 area 相同；没有权限的导航不显示。icon 用 pixelarticons 文件名（kebab-case），例如 mail、cloud-server；未知名显示积木。页面权限和数据路由权限要分别声明。

下面是一个完整表格定义，数据先固定返回，之后可以换成插件表查询：

```ts
import { definePlugin } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  routes: {
    'GET /items': {
      auth: 'user',
      async handler() {
        return Response.json({ rows: [{ code: 'demo', used: false }], total: 1 })
      },
    },
  },
  ui: {
    nav: [{ area: 'user', page: 'items', label: 'page.items', icon: 'list' }],
    pages: {
      items: {
        area: 'user',
        title: 'page.items',
        view: {
          kind: 'table',
          source: '/items',
          columns: [
            { key: 'code', label: 'field.code', format: 'code' },
            { key: 'used', label: 'field.used', format: 'boolean' },
          ],
        },
      },
    },
  },
})
```

page.items、field.code、field.used 需写进 locales。后台名字和简介按 `plugin.name`、`plugin.description` 取；其他 label、title、help、placeholder、confirm 都填本插件文案键。设置的专用键见[设置](./settings.md)。

## 四种视图的数据

| kind | 声明和数据源 |
|---|---|
| table | source 路由返回 HTTP 200、JSON `{ rows: Record<string, Json>[], total: number }`；columns 按 key 读取每行的直接属性，不解析点路径 |
| form | fields 声明输入；可选 load 用 GET 返回 HTTP 200 的 JSON 对象作为初始值；不写 load 则为空对象。submit 指定 route、POST/PUT/PATCH 和按钮 label |
| stats | source 返回 HTTP 200、JSON `{ items: [{ label: MessageKey, value: number \| string }] }`；label 再翻译，数字按当前语言格式化 |
| markdown | source 返回 HTTP 200、text/markdown 正文；核心不渲染原始 HTML。代码块（三个反引号围起来的）右上角带复制按钮，复制整块的文字、不带末尾的换行，适合放要用户复制走的命令或地址 |

数据源由页面在服务端调用插件 GET 路由，仍检查身份、权限、限流、期限。加载失败或形状不合格显示“没能加载”。public 数据源即使在登录页面中调用也匿名。

table 默认每页 50 行，发送 page（从 1 开始）、pageSize=50；searchable=true 时发送 trim 并截到 64 个 UTF-16 代码单元的 q，空查询省略。source 原有查询参数保留，分页参数覆盖同名键，不会拼两个问号。插件自己解析、校验并执行分页；total 是匹配记录总数，不是本页数量。核心最多渲染返回的前 100 个对象行，total 会截成非负整数。不要依赖浏览器传来的 pageSize 来限制数据库结果。

## 六种字段

所有 Field 都有 name、type、label，可选 required、help。区别如下：

| type | 额外属性和提交方式 |
|---|---|
| text | placeholder 文案键、maxLength（非负整数）；文本 |
| textarea | 同上，多行文本 |
| password | 同上，密码输入；不会因此自动加密路由中的数据 |
| number | 只有 placeholder，没有 maxLength；插件 form/Action 提交 JSON 数字，空着的数字字段不提交 |
| boolean | 不接受 placeholder、maxLength 或 options；提交 JSON 布尔值 |
| select | 必须有至少一个 `{ value: string, label: MessageKey }` 选项；没有 placeholder、maxLength；提交字符串值 |

插件 form 和 Action 提交 JSON 对象，文本不由核心业务层自动校验；required 和 maxLength 是浏览器输入约束，handler 仍须用 zod 等检查。响应 2xx 显示成功；可返回 `{ message: string }` 作为提示。失败可返回 `{ error: string }` 或 `{ message: string }`，填写的表单内容保留。浏览器发这些请求时不跟随重定向：路由回 3xx 按失败显示，否则插件就能借用户的会话把请求转到核心的接口上。

## 九种列格式

null、undefined、空串统一显示破折号；其余按下表渲染。

| format | 实际渲染 |
|---|---|
| text（默认） | 字符串原样；数字、布尔转字符串；对象和数组按 JSON 显示 |
| code | 等宽 code 文本 |
| number | 真正的 number 按当前语言格式化；数字字符串仍按文本显示 |
| datetime | 字符串或数字交给 Date 解析，按当前语言显示短日期和时间；非法日期显示破折号 |
| boolean | 只有 true、1、字符串"true"显示“是”，其他非空值显示“否” |
| status | 值的文本放进 Badge，不自动映射状态或翻译 |
| user | 值是 uid，核心查公开昵称和头像；后台带用户查询链接，用户区不带链接；找不到显示#原值 |
| player | 值是 pid，只显示角色名；找不到显示#原值 |
| texture | 值是 tid，显示指向 `/skinlib/{tid}` 的#tid 链接；不是数字或纯数字字符串则破折号 |

user/player 列的公开引用由核心查，不要求插件申请读取能力；每种引用最多收集 500 个有效正安全整数 id。这不赋予 handler 读取私有资料的权限。

## 行动作和路径

table 的 toolbar 放工具栏动作，rowActions 放每行动作。Action 有 label、method（POST/PUT/PATCH/DELETE）、route，可选 tone（default/danger）、confirm 文案键、form 字段。提供 confirm 会先确认；form 会先弹表单，其 JSON 作为 body。没有表单时不自动把整行作为请求体。

route 可以写 `/codes/:code`，用当前行的 code 替换；占位符匹配 `:([A-Za-z][A-Za-z0-9_]*)`。值必须是字符串或有限数字，不能是 `.`、`..`；缺失、布尔、对象、NaN 等会让操作失败并提示，不会默默转空串。值经过 encodeURIComponent。工具栏没有当前行，不能使用缺少值的占位符。

source、load、submit.route、Action.route 都相对于 `/plugins/{id}`，必须以 `/` 开头，可带查询参数。除根 `/` 外，不能有空段、末尾斜杠、独立的 `.`/`..` 段、反斜杠、`#`；百分号解码后的路径段同样检查，解码后的斜杠也不允许。文件名中的点（如 `/report.json`）可以用。构建校验路径，浏览器和服务端拼 URL 后还要检查同源且留在本插件前缀下。

## 注册表单字段

`ui.formFields` 只能扩展 `auth.register`：

```ts
formFields: [
  {
    form: 'auth.register',
    fromQuery: true,
    field: { name: 'invitationCode', type: 'text', label: 'field.code', required: true, maxLength: 64 },
  },
]
```

上段放在 ui 对象中。字段名匹配 `^[A-Za-z][A-Za-z0-9]{0,31}$`，同一插件不能重复。普通注册和第三方“完成注册”页都显示，值只传给本插件拦截器和 user.registered 事件的 extra。

条目可选 `fromQuery: true`，只允许 text、textarea、number、select；password 和 boolean 不允许。打开 `/sign-up` 时，查询参数 `<插件 id>.<字段名>` 的值作为初始值。例如插件 example 的 invitationCode 可用 `/sign-up?example.invitationCode=abc`。参数由插件自己拼（可用 URLSearchParams），核心参数不用带点的名字，不会互相占用。用户看得到、改得了，提交后照常校验，不能把预填值当成可信输入。

从注册页转去第三方登录，参数不经过 OAuth 往返，所以“完成注册”页没有这个初始值。省略 fromQuery 或设为 false 时照旧由用户填写。

这里与插件自己的 form 不同：extra 统一是字符串。文本 trim，默认最多 1000 个 Unicode 码点，禁止 NUL；空值省略，必填空值报错。number 须能转为有限数字，select 须在 options 中。boolean 转成"true"/"false"，required boolean 必须为 true。错误字段键为 `<插件id>.<字段名>`。不要把密码、令牌当成注册 extra，因为它会进入持久事件载荷。

完整例子见 [invitation-codes](https://github.com/Glasden/NextSkin/tree/main/plugins/invitation-codes) 和 [cdn-refresh](https://github.com/Glasden/NextSkin/tree/main/plugins/cdn-refresh)。

## 配色主题

`ui.themes` 可以声明多套配色主题，不需要能力。主题只交颜色数据和结构枚举（圆角、边框、卡片），由核心补齐、检查并生成 CSS；新主题默认不启用，由超级管理员在后台主题页启用，用户在用户中心选择。可改的 token、推导和检查规则见[配色主题](./themes.md)。
