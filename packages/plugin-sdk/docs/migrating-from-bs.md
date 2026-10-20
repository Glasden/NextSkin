# 从 BS 迁移

这一篇给已有 BS 插件的作者和代为迁移的 agent。先按功能找对应扩展点，再写新的 TypeScript 插件；不要逐行翻译 PHP，也不要照搬 BS 内部模型、表结构或 Twig 页面。

## Hook、Event、Filter 对照

| BS 写法或扩展点 | NextSkin 第一版 |
|---|---|
| bootstrap.php 里注册回调 | `src/index.ts` 默认导出 definePlugin；没有 setup 或动态 ctx.on |
| Hook::addRoute、ConfigureRoutes | routes，固定挂在 `/plugins/{id}`；登录、权限、限流和请求体上限由网关处理 |
| Hook::addMenuItem、ConfigureUserMenu、ConfigureAdminMenu | ui.nav 和 ui.pages |
| Hook::addScriptFileToPage、addStyleFileToPage、RenderingHeader/Footer 的 addContent | 无脚本、样式或 HTML 注入；改成声明式页面、注册字段，做不到的部分要删去或等待新扩展点 |
| UserRegistered、auth.registration.completed | `on['user.registered']`，事务提交后异步投递，至少一次 |
| UserProfileUpdated | user.profileUpdated，只给 uid 和 fields，不暴露可修改的 Eloquent 用户 |
| PlayerWasAdded、PlayerWasDeleted | player.created、player.deleted |
| PlayerProfileUpdated | 按动作分别用 player.renamed、player.texturesChanged |
| player.owner.updated | player.transferred |
| PlayerWillBeAdded/Deleted、TextureDeleting | 第一版没有对应的前置拦截器；完成后可订阅 player.created/deleted、texture.deleted |
| PlayerRetrieved | 没有读取时任意改核心结果的 filter；用只读 players API，不能替换协议返回 |
| UserAuthenticated、UserLoggedIn、UserTryToLogin | 没有通用登录事件或登录拦截点；外部密码用 passwordHasher，第三方登录用 login Provider |
| Filter 的 can_register、Rejection | intercept 的 user.register、deny(code, message)，只能拒绝，不能改字段 |
| verify_password | passwordHasher；用 detect 认领自包含的 hash，不再接收整个用户模型 |
| user_password | 不提供自定义核心写入密码算法；新密码由核心生成，旧格式按 Provider 验证后迁移 |
| new_player_name、can_set_texture、uploaded_texture_hash、can_upload_texture 等 | 无通用 Filter；不能改角色 UUID、材质 hash 或任意业务结果 |
| `grid:*`、`auth_page_rows:*` | 没有任意改核心界面结构；注册加字段用 ui.formFields，其余用插件自己的页面 |
| plugin 启用、停用、删除生命周期事件 | 没有公开生命周期 handler；建表用 migrations，后台工作用 jobs/cron，取消监听 ctx.signal |

事件完整字段见[事件](./events.md)。新事件处理函数不再和原请求同步完成，不能用抛错来撤回已经提交的业务，也不能假设两个事件按发出顺序执行。

## PHP 到 TypeScript 的常见对应

| 旧习惯 | 新写法 |
|---|---|
| option()和插件配置表单 | settings: z.object，读取 ctx.settings；机密顶层 secret() |
| trans()、lang 目录 | locales/zh-CN.json、en.json，ctx.t；使用 ICU 格式 |
| Filter::add 或注入的$filter->add | 注册限制用 intercept；密码识别用 Provider；没有可任意改数据的通用 filter |
| Laravel 队列、定时命令 | jobs、ctx.jobs.enqueue、cron，载荷可 JSON 序列化，处理函数幂等 |
| Eloquent、DB::table | 只读核心数据用 ctx.users/players/textures；自有表用 table、migrations、ctx.db |
| session 存临时业务状态 | 优先显式参数或本插件 KV；插件拿不到站点会话存储，不能写 Cookie |
| Guzzle | ctx.fetch，先在 network 声明 HTTPS origin |
| abort/json/Response | 路由返回 Web Response；业务错误自己校验，拦截拒绝用 deny |
| Carbon、DateTime | 内部计算可用 Date，跨 API 和数据库参数用 UTC ISO 字符串 |
| Composer 依赖 | 可打进单文件的 npm 依赖；SDK、zod 由 host 提供，不能依赖未发布核心包 |

## BS 官方插件的去向

下表保留 ADR-0010 的迁移分类，并按 ADR-0033、0034 和当前已实现范围修正。**“核心方向”不表示每个旧功能都已经完成**，不要把设计决定当成可调用 API。

| 去向 | BS 插件和当前边界 |
|---|---|
| 核心协议和基础功能 | yggdrasil-api、usm-api、legacy-api、config-generator、204-for-unexisted-players、insane-profile-cache；协议路径和响应由核心兼容 |
| 核心认证、设置和导入 | password-algorithm-transition、disable-registration、restricted-email-domains、single-player-limit、texture-description、gravatar、trust-proxies、remote-addr、predis；batch-import 并入导入器。旧插件的每个细节不一定有独立开关，不要再接核心内部类 |
| 核心已实现（部分） | yggdrasil-connect：设备码流程、公用应用、进服认 OAuth 令牌和安全页的“已授权的应用”已由核心实现（ADR-0037），导入器把 Janus 标记的应用转成公共客户端；授权码流程的同意页和“OAuth 应用”管理页还没做。没有可替代的插件 API |
| S3 兼容存储驱动 | textures-aliyun-oss、textures-qcloud-cos、textures-qiniu-storage，站长配置存储，不通过插件提供存储驱动 |
| 已迁为参考插件 | invitation-codes → invitation-codes；refresh-ali-cdn、refresh-qcloud-cdn、purge-azure-global-cdn → cdn-refresh |
| 密码兼容部分 | authme-integration → authme-password；直接连接 AuthMe 数据库、读写核心 users 表的部分不迁 |
| 第三方登录 | oauth 及 oauth-github/google/microsoft-live/littleskin → oauth-github、oauth-google、oauth-microsoft、oauth-littleskin，一家一个插件，不再依赖 BS 的 oauth 基座 |
| 第一版推迟 | mojang-verification 需要写核心数据；forum-integration 还需要外部数据库，没有完整对应实现 |
| 不迁移 | hello-dolly、pray-for-kyoto-animation、eruda、hitokoto 等注入内容或脚本类插件；google-adsense、gtag-js 的方向是核心受控统计/广告设置，不是开放浏览器脚本 API，该设置尚非第一版已实现功能 |

## 第一版迁移不了的部分

| 类别 | 原因 | 可行替代 |
|---|---|---|
| 写核心数据（积分、通知、指定 UUID 建角色等） | 只有只读 DTO 能力，写入必须经过专门的领域用例和审计；相应能力未开放 | 删除这部分自动化，使用核心已有管理流程；需要新能力时向核心提扩展点需求，不能用插件表或核心 HTTP 接口冒充用例权限 |
| 浏览器执行代码、自定义组件和插槽 | 第一版只有声明式 UI，不提供 ui.script，也不允许 HTML 注入 | 表格、表单、统计、Markdown、注册字段；超出范围等后续 API |
| 验证码 | 挂件依赖浏览器组件，验证码 Provider 未开放；设计已改为核心配置 Turnstile/hCaptcha/reCAPTCHA | 等核心验证码功能，不把第三方 secret 和脚本塞进注册 extra；当前仍是未完成项 |
| 外部数据库 | host 没有外部数据库凭据或任意连接能力，ctx.db 只能访问插件自有表 | 先离线迁入自有表，或由独立服务提供受鉴权 HTTPS API；后者只能在允许网络的调用点使用 |
| 常驻连接（机器人、WebSocket 客户端等） | 没有 setup 生命周期，host 会整代切换，ctx 仅在单次调用有效 | 独立服务，或有期限的 jobs/cron 轮询；不要在顶层偷偷创建常驻连接 |
| 事务内访问外部系统再决定放行 | user.register 只给本地成员和插件 db，写锁内不能等网络，副作用无法回滚 | 预先同步到插件表；不能接受快照的规则要等待新的事务外拦截点 |

## 示例：邀请码插件

BS 社区的 invitation-codes 3.1.2（printempw）旧实现做了四件事：bootstrap 注入 register.js 显示邀请码字段，注册 can_register 过滤器，过滤器读 invitation_codes 并把使用中的码存进 session，最后监听 auth.registration.completed 写 used_by 和 used_at。后台用 Laravel 路由和 Twig 表格。

新写法把“占用名额”移到注册事务里的一条条件 UPDATE；这比把旧的先读后写直接翻译成 TS 更重要。下面是保留核心约束的完整定义，表中的码由你后续添加的管理路由生成：

```ts
import { definePlugin, deny, table } from '@nextskin/plugin-sdk'

interface CodeRow {
  code: string
  status: string
  used_by: number | null
}

export default definePlugin({
  capabilities: ['storage.tables'],
  tables: { codes: table<CodeRow>() },
  migrations: {
    '0001_create_codes': {
      async up(db) {
        await db.schema
          .createTable('codes')
          .addColumn('code', 'varchar(32)', (c) => c.primaryKey())
          .addColumn('status', 'varchar(16)', (c) => c.notNull())
          .addColumn('used_by', 'integer')
          .execute()
      },
    },
  },
  ui: {
    formFields: [
      {
        form: 'auth.register',
        field: { name: 'code', type: 'text', label: 'field.code', required: true, maxLength: 32 },
      },
    ],
  },
  intercept: {
    'user.register': async ({ input, ctx }) => {
      const result = await ctx.db
        .updateTable('codes')
        .set({ status: 'used' })
        .where('code', '=', input.extra.code ?? '')
        .where('status', '=', 'unused')
        .executeTakeFirstOrThrow()
      if (result.numUpdatedRows !== 1n) return deny('invalid_code', ctx.t('error.invalidCode'))
    },
  },
  on: {
    'user.registered': async ({ event, ctx }) => {
      await ctx.db
        .updateTable('codes')
        .set({ used_by: event.data.user.uid })
        .where('code', '=', event.data.extra.code ?? '')
        .where('status', '=', 'used')
        .execute()
    },
  },
})
```

将 field.code、error.invalidCode 写进 locales，按[入门](./getting-started.md)补 package.json 即可构建。注册失败时 status 随核心事务回滚；user.registered 只负责补 uid，重复写同一个 uid 是幂等的。不能把异步事件里的更新当成阻止并发注册的措施。

再加 permissions、routes、ui.pages/nav 做管理页，不再注入 JS 或 Twig。可直接参考完整的 [invitation-codes](https://github.com/Glasden/NextSkin/tree/main/plugins/invitation-codes)，它还处理生成、有效期、分页和后台操作。其他迁移可参考 [authme-password](https://github.com/Glasden/NextSkin/tree/main/plugins/authme-password)、[cdn-refresh](https://github.com/Glasden/NextSkin/tree/main/plugins/cdn-refresh)、[oauth-github](https://github.com/Glasden/NextSkin/tree/main/plugins/oauth-github)。
