# 设置

用 `settings: z.object(...)` 声明插件设置，核心自动生成后台详情页的控件。你不需要再写设置表、设置路由或表单。

```ts
import { definePlugin, secret, z } from '@nextskin/plugin-sdk'

export default definePlugin({
  capabilities: [],
  settings: z.object({
    enabled: z.boolean().default(true),
    endpoint: z.url(),
    token: secret(),
    mode: z.enum(['fast', 'safe']).default('safe'),
    batch: z.object({
      size: z.number().int().min(1).max(100).default(20),
      policy: z.enum(['skip', 'retry']).default('retry'),
    }),
    notice: z.string().max(2000).meta({ contentMediaType: 'text/markdown' }).default(''),
    hosts: z.array(z.string()).default([]),
  }),
  jobs: {
    inspect: {
      async handler({ ctx }) {
        ctx.log.info('当前模式', { mode: ctx.settings.mode })
      },
    },
  },
})
```

示例里的 endpoint 和 token 需管理员填写。使用 SDK 导出的 `z` 和 `secret`，不要带进另一份 zod 运行时；构建和 host 要共享同一份机密元数据标记。

## 支持的形状是契约

settings 在类型上仍是任意 z.object，**能生成控件的范围以本节为准**。这是 SDK 的明确例外，之后只放宽、不收紧。构建命令和核心加载时使用相同检查，不支持的形状会在构建时报错。

| schema 形状 | 控件和限制 |
|---|---|
| 字符串 | 单行文本；识别 minLength、maxLength，URL（JSON Schema 的 uri）和 email 格式分别用 URL、邮箱输入 |
| 数字、整数 | 数字控件，识别 minimum、maximum 和整数 |
| 布尔 | 开关 |
| 字符串枚举 | 下拉选项，值必须都是字符串 |
| 字符串数组 | 多行文本，每行一项 |
| Markdown 字符串 | `z.string().meta({ contentMediaType: 'text/markdown' })`，Markdown 编辑控件，不渲染原始 HTML |
| 一层对象 | 展开属性；属性能是上述普通控件，但不能再嵌对象或机密 |
| 顶层 secret | 密码框；`contentMediaType: 'application/x-pem-file'` 元数据可用多行机密输入 |

一般联合、字面量常量、引用、复杂组合、对象数组等没有对应控件。可选的格式化字符串有一个例外：`z.union([z.literal(''), z.url()])` 或邮箱版本表示允许空串，控件不设必填。普通字符串要多行编辑时用字符串数组；长篇内容用 Markdown 元数据。

机密必须是 settings 的**顶层单独一项**。`z.object({ nested: z.object({ token: secret() }) })`、`z.array(secret())` 这类嵌套机密构建时拒绝。顶层机密支持字符串或可空字符串形状；优先直接用 secret()，是否必填、默认值由你的 schema 决定。

## 文案键

文案写在 `locales/<语言>.json`。以下键按约定取，不在 UI 里另行声明：

| 用途 | 键 |
|---|---|
| 标签、帮助 | `settings.<键>.label`、`settings.<键>.help` |
| 枚举选项 | `settings.<键>.options.<值>` |
| 对象属性标签、帮助 | `settings.<键>.fields.<属性>.label`、`settings.<键>.fields.<属性>.help` |
| 对象属性枚举选项 | `settings.<键>.fields.<属性>.options.<值>` |

例如 batch.policy 的 retry 选项是 `settings.batch.fields.policy.options.retry`。缺少文案会显示相应键名，记得提供站点常用语言。

## 保存、校验和机密

设置按插件隔离，顶层键分别存储。机密项加密存储，不回传到浏览器，后台只获得 isSet；审计记录不含机密值。handler 里的 ctx.settings 包含解密值，不要转回浏览器或日志。管理员留空保留已存机密，重置操作才清除。

保存时先按 manifest 的 JSON Schema 校验每项，再把合并后的完整设置交给插件自己的 zod schema 校验，期限 5 秒，所以 refine/superRefine 仍有效。两次校验都过才保存；host 不可用时不能改设置。API 用 invalid_request 和出错的顶层字段名提示，页面标记字段；不会把你自写的 zod 错误消息当成完整用户提示。

每次业务调用前会重新解析设置并应用 default。未填必填项、解密失败后没有有效默认值等会报“插件设置不完整或无效；请先在后台的插件设置页填写”，handler 不执行。登录按钮的显隐先检查 manifest 的必填项和 JSON Schema，不执行自定义 refine；因此 refine 失败仍可能在点击后才发现。

跨字段校验和机密的完整例子见 [cdn-refresh](https://github.com/Glasden/NextSkin/tree/main/plugins/cdn-refresh)。
