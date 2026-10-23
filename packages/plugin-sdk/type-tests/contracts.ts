/**
 * 类型层面的契约测试：这些 @ts-expect-error 一旦不再报错，说明 SDK 的约束被放松了。
 * 由 `tsc --noEmit` 执行。
 *
 * 注意：同一个 definePlugin 调用的对象字面量里只放一个结构性错误。
 * TypeScript 对一个参数只报告第一处不可赋值，多放的 @ts-expect-error 会被误判为"未使用"。
 */
import { definePlugin, deny, secret, table, z, type ExternalIdentity } from '@nextskin/plugin-sdk'

// 主题是数据，不需要能力；亮暗都可以省略或只写部分颜色。
/* eslint-disable nextskin/no-raw-color -- 公开主题类型接受的色值是数据，需直接验证类型约束。 */
definePlugin({
  capabilities: [],
  ui: {
    themes: [
      { name: 'cobalt', label: 'themes.cobalt', colors: { light: { accent: '#2a52e5' }, dark: { accent: '#86A2FF' } } },
      {
        name: 'high-contrast',
        label: 'themes.highContrast',
        structure: { radius: 'square', borders: 'thick', cards: 'raised' },
        colors: { light: { 'accent-fill': '#d4ff1e', 'accent-fill-fg': '#000000' } },
      },
      { name: 'partial', label: 'themes.partial', structure: { radius: 'rounded' }, colors: {} },
      { name: 'default', label: 'themes.default', colors: {} },
      { name: 'light', label: 'themes.light', colors: { light: { focus: '#2a52e5' } } },
      { name: 'dark', label: 'themes.dark', colors: { dark: { 'accent-subtle': '#282f41' } } },
    ],
  },
})

definePlugin({
  capabilities: [],
  ui: {
    themes: [
      {
        name: 'typo',
        label: 'themes.typo',
        colors: {
          light: {
            // @ts-expect-error token 名必须属于公开的 ThemeColor
            acent: '#2a52e5',
          },
        },
      },
    ],
  },
})

definePlugin({
  capabilities: [],
  ui: {
    themes: [
      {
        name: 'invalid',
        label: 'themes.invalid',
        colors: {
          dark: {
            // @ts-expect-error 色值必须以 # 开头，六位格式在构建时检查
            accent: '86a2ff',
          },
        },
      },
    ],
  },
})

definePlugin({
  capabilities: [],
  ui: {
    themes: [
      {
        name: 'typo',
        label: 'themes.typo',
        colors: {},
        structure: {
          // @ts-expect-error 圆角只能选 rounded 或 square
          radius: 'round',
        },
      },
    ],
  },
})

definePlugin({
  capabilities: [],
  ui: {
    themes: [
      {
        name: 'unknown',
        label: 'themes.unknown',
        colors: {},
        structure: {
          // @ts-expect-error 结构不接受未知键或 CSS
          shadow: 'none',
        },
      },
    ],
  },
})

/* eslint-enable nextskin/no-raw-color */

// 转让事件不需要能力，携带新主人和原主人的 uid。
definePlugin({
  capabilities: [],
  on: {
    'player.transferred': async ({ event }) => {
      const uid: number = event.data.player.uid
      const previousUid: number = event.data.previousUid
      void [uid, previousUid]
    },
  },
})

// 没申请 storage.tables 就没有 ctx.db；没申请 users.readPrivate 就看不到邮箱。
definePlugin({
  capabilities: ['users.read'],
  on: {
    'user.registered': async ({ event, ctx }) => {
      // @ts-expect-error ctx.db 需要 storage.tables
      ctx.db
      const user = await ctx.users.get(event.data.user.uid)
      // @ts-expect-error email 需要 users.readPrivate
      user?.email
      // @ts-expect-error adjustScore 需要 users.score（ADR-0041）
      ctx.users.adjustScore
      const [found] = await ctx.users.searchByNickname('steve', { after: 1, limit: 100 })
      // @ts-expect-error 按昵称搜到的也是公开 DTO（ADR-0050）
      found?.email
    },
  },
})

// users.readPrivate 下按昵称搜到的是私有 DTO（ADR-0050）。
definePlugin({
  capabilities: ['users.readPrivate'],
  on: {
    'user.registered': async ({ ctx }) => {
      const [found] = await ctx.users.searchByNickname('steve')
      const email: string | undefined = found?.email
      void email
    },
  },
})

// 改积分按申请能力收窄，事务内仍然不可用（ADR-0041）。
definePlugin({
  capabilities: ['users.score'],
  on: {
    'user.registered': async ({ ctx, event }) => {
      await ctx.users.adjustScore(event.data.user.uid, 1, { reason: 'reward', key: 'once' })
      // @ts-expect-error 只申请 users.score 就没有 get
      ctx.users.get
      // @ts-expect-error 也没有 searchByNickname
      ctx.users.searchByNickname
    },
  },
})
definePlugin({
  capabilities: ['users.read', 'users.score'],
  on: {
    'user.registered': async ({ ctx, event }) => {
      await ctx.users.get(event.data.user.uid)
      await ctx.users.adjustScore(event.data.user.uid, 1, { reason: 'reward', key: 'once' })
    },
  },
})
definePlugin({
  capabilities: ['users.score'],
  intercept: {
    'user.register': async ({ ctx }) => {
      // @ts-expect-error 事务内没有 adjustScore
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- 故意访问不存在的 users，守护事务上下文约束。
      ctx.users.adjustScore
    },
  },
})
// 推迟到以后的能力不存在（ADR-0033）。
definePlugin({
  // @ts-expect-error 运行时组件推迟了
  capabilities: ['ui.script'],
})

// 只能访问 tables 里声明过的表。
definePlugin({
  capabilities: ['storage.tables'],
  tables: { codes: table<{ code: string }>() },
  routes: {
    'GET /x': {
      auth: 'public',
      async handler({ ctx }) {
        await ctx.db.selectFrom('codes').selectAll().execute()
        // @ts-expect-error 未声明的表
        await ctx.db.selectFrom('users').selectAll().execute()
        return new Response()
      },
    },
  },
})

// 设置项类型来自 zod schema。
definePlugin({
  capabilities: [],
  settings: z.object({ limit: z.number().default(3) }),
  on: {
    'player.created': async ({ ctx }) => {
      const limit: number = ctx.settings.limit
      // @ts-expect-error 不存在的设置项
      ctx.settings.missing
      void limit
    },
  },
})

// user.register 只能拒绝，不能改字段。
definePlugin({
  capabilities: [],
  intercept: {
    'user.register': async ({ input }) => {
      if (input.email.endsWith('@example.com')) return deny('blocked_domain', '不支持该邮箱域名')
    },
  },
})
definePlugin({
  capabilities: [],
  intercept: {
    // @ts-expect-error 拦截器不能改字段
    'user.register': async () => ({ action: 'patch', patch: { nickname: 'x' } }),
  },
})
definePlugin({
  capabilities: [],
  intercept: {
    // @ts-expect-error 不存在的拦截点
    'player.create': async () => {},
  },
})

// 事务内的拦截器只有 db 和不用等核心回应的几项。
definePlugin({
  capabilities: ['storage.tables', 'storage.kv', 'users.read'],
  settings: z.object({ required: z.boolean().default(true) }),
  tables: { codes: table<{ code: string }>() },
  intercept: {
    'user.register': async ({ ctx }) => {
      const required: boolean = ctx.settings.required
      await ctx.db.selectFrom('codes').selectAll().execute()
      ctx.log.info('checked', { required })
      void ctx.t('error.invalidCode')
      void ctx.signal
      // @ts-expect-error 事务内不能发网络请求
      ctx.fetch
      // @ts-expect-error 事务内不能写 KV
      ctx.kv
      // @ts-expect-error 事务内不能入队
      ctx.jobs
      // @ts-expect-error 事务内不能读核心数据
      ctx.users
    },
  },
  on: {
    'user.registered': async ({ ctx }) => {
      // 事件处理函数里照常可用
      await ctx.kv.set('k', 1)
      await ctx.users.get(1)
      void ctx.fetch
    },
  },
})

// 插件不能自己开事务，也不能在迁移以外执行 DDL。
definePlugin({
  capabilities: ['storage.tables'],
  tables: { codes: table<{ code: string }>() },
  migrations: {
    '0001_create_codes': {
      async up(db) {
        await db.schema.createTable('codes').addColumn('code', 'varchar(32)').execute()
        // @ts-expect-error 迁移里也不能开事务
        db.transaction
      },
    },
  },
  on: {
    'player.created': async ({ ctx }) => {
      // @ts-expect-error 不能开事务
      ctx.db.transaction
      // @ts-expect-error 不能开受控事务
      ctx.db.startTransaction
      // @ts-expect-error 不能独占连接
      ctx.db.connection
      // @ts-expect-error DDL 只在迁移里
      ctx.db.schema
      // @ts-expect-error 换插件会绕过上面的限制
      ctx.db.withPlugin
    },
  },
})

// 只有注册表单能加字段；没有逃生舱 setup。
definePlugin({
  capabilities: [],
  ui: {
    formFields: [
      {
        // @ts-expect-error 只有 auth.register
        form: 'user.profile',
        field: { name: 'x', type: 'text', label: 'field.x' },
      },
    ],
  },
})
definePlugin({
  capabilities: [],
  // @ts-expect-error setup 推迟了
  setup: async () => {},
})
definePlugin({
  capabilities: [],
  ui: {
    pages: {
      // @ts-expect-error 没有运行时组件
      x: { area: 'admin', title: 'page.x', view: { kind: 'component', module: { path: './x.js' } } },
    },
  },
})

// 机密设置项是非空字符串。
definePlugin({
  capabilities: [],
  settings: z.object({ token: secret() }),
  on: {
    'texture.deleted': async ({ ctx }) => {
      const token: string = ctx.settings.token
      void token
    },
  },
})

// 权限名必须是本插件声明过的；需要登录的路由里 actor 一定是用户。
definePlugin({
  capabilities: [],
  permissions: { manage: 'permission.manage' },
  routes: {
    'POST /a': {
      auth: 'user',
      permission: 'manage',
      async handler({ scope }) {
        return Response.json({ uid: scope.actor.uid })
      },
    },
    'GET /c': {
      auth: 'public',
      async handler({ scope }) {
        const kind: 'system' = scope.actor.kind
        void kind
        // @ts-expect-error 公开路由一律匿名
        scope.actor.uid
        return new Response()
      },
    },
  },
})
definePlugin({
  capabilities: [],
  permissions: { manage: 'permission.manage' },
  routes: {
    'POST /b': {
      auth: 'user',
      // @ts-expect-error 未声明的权限
      permission: 'nope',
      async handler() {
        return new Response()
      },
    },
  },
})
definePlugin({
  capabilities: [],
  routes: {
    // @ts-expect-error 路由键必须是 'METHOD /path'
    'FETCH /d': { auth: 'public', handler: async () => new Response() },
  },
})

// 未知的事件名会被拒绝。
definePlugin({
  capabilities: [],
  on: {
    // @ts-expect-error 不存在的事件
    'texture.liked': async () => {},
  },
})
definePlugin({
  capabilities: [],
  on: {
    // @ts-expect-error 核心没有发出登录事件（ADR-0033）
    'user.loggedIn': async () => {},
  },
})

// 注销后的上传者与描述是材质 DTO 的契约；事件允许只更新描述。
definePlugin({
  capabilities: ['textures.read'],
  on: {
    'texture.updated': async ({ event, ctx }) => {
      const texture = await ctx.textures.get(event.data.texture.tid)
      const uploader: number | null | undefined = texture?.uploader
      const description: string | null | undefined = texture?.description
      const fields: readonly string[] = event.data.fields
      void uploader
      void description
      void fields
      // @ts-expect-error 上传者注销后可空，不能假设始终是 uid。
      const uid: number = event.data.texture.uploader
      void uid
    },
  },
})

// login Provider 只交出第三方的身份：没有头像地址（站内头像来自材质），emailVerified 要写明（ADR-0034）。
declare const identity: ExternalIdentity
// @ts-expect-error 没有 avatarUrl
void identity.avatarUrl
definePlugin({
  capabilities: [],
  providers: {
    login: [
      {
        id: 'example',
        label: 'login.example',
        icon: 'login',
        authorizeUrl: async ({ state }) => `https://example.test/authorize?state=${state}`,
        // @ts-expect-error 拿不准邮箱是否验证过也要写 false，不能省略
        exchange: async () => ({ subject: '1', email: 'steve@example.test', displayName: null }),
      },
    ],
  },
})

// 出站请求只有核心实际支持的参数。
definePlugin({
  capabilities: [],
  jobs: {
    check: {
      async handler({ ctx }) {
        await ctx.fetch(new URL('https://example.test'), { method: 'OPTIONS', body: null })
        // @ts-expect-error 不接受 Request
        await ctx.fetch(new Request('https://example.test'))
        // @ts-expect-error 重定向由核心处理
        await ctx.fetch('https://example.test', { redirect: 'manual' })
        // @ts-expect-error 取消由 ctx.signal 决定
        await ctx.fetch('https://example.test', { signal: new AbortController().signal })
        // @ts-expect-error 不支持 TRACE
        await ctx.fetch('https://example.test', { method: 'TRACE' })
      },
    },
  },
})

definePlugin({
  capabilities: [],
  routes: {
    'GET /x': {
      auth: 'public',
      // @ts-expect-error public 路由只能按 ip 限流
      rateLimit: { limit: 1, windowSec: 1, by: 'user' },
      handler: async () => new Response(),
    },
  },
})

definePlugin({
  capabilities: [],
  providers: {
    passwordHasher: [
      {
        id: 'x',
        label: 'x',
        // @ts-expect-error detect 至少写一项
        detect: {},
        verify: async () => false,
      },
    ],
  },
})

import type {
  Field,
  PluginManifest,
  PluginDb,
  PluginMigrationDb,
  CoreEvents,
  TextureType,
  UserRole,
} from '@nextskin/plugin-sdk'
// @ts-expect-error select 必须有选项
const missingOptions: Field = { name: 'x', label: 'x', type: 'select' }
// @ts-expect-error select 的选项不能为空
const emptyOptions: Field = { name: 'x', label: 'x', type: 'select', options: [] }
// @ts-expect-error boolean 不使用 placeholder
const booleanPlaceholder: Field = { name: 'x', label: 'x', type: 'boolean', placeholder: 'x' }
const selectPlaceholder: Field = {
  name: 'x',
  label: 'x',
  type: 'select',
  options: [{ value: 'x', label: 'x' }],
  // @ts-expect-error select 不使用 placeholder
  placeholder: 'x',
}
// @ts-expect-error number 不使用 maxLength
const numberLength: Field = { name: 'x', label: 'x', type: 'number', maxLength: 2 }
// @ts-expect-error boolean 不使用 maxLength
const booleanLength: Field = { name: 'x', label: 'x', type: 'boolean', maxLength: 2 }
// @ts-expect-error text 不使用 options
const textOptions: Field = { name: 'x', label: 'x', type: 'text', options: [{ value: 'x', label: 'x' }] }
// @ts-expect-error 可安装清单必须有入口
const noServer: PluginManifest['entry'] = { server: null }
void [
  missingOptions,
  emptyOptions,
  booleanPlaceholder,
  selectPlaceholder,
  numberLength,
  booleanLength,
  textOptions,
  noServer,
]

declare const pluginDb: PluginDb<Record<never, never>>
declare const migrationDb: PluginMigrationDb
// @ts-expect-error 网关不支持 with
void pluginDb.with
// @ts-expect-error 网关不支持 withRecursive
void pluginDb.withRecursive
// @ts-expect-error 网关不支持 mergeInto
void pluginDb.mergeInto
// @ts-expect-error 网关不支持 replaceInto
void pluginDb.replaceInto
// 编译后的白名单查询仍然可执行。
void pluginDb.executeQuery
// @ts-expect-error 网关不支持 with
void migrationDb.with
// @ts-expect-error 网关不支持 withRecursive
void migrationDb.withRecursive
// @ts-expect-error 网关不支持 mergeInto
void migrationDb.mergeInto
// @ts-expect-error 网关不支持 replaceInto
void migrationDb.replaceInto
// 编译后的白名单查询仍然可执行。
void migrationDb.executeQuery

function receiveRole(value: UserRole) {
  switch (value) {
    case 'banned':
    case 'user':
    case 'admin':
    case 'superadmin':
      return
    default: {
      // @ts-expect-error 覆盖已知成员后仍须处理次版本新增的值
      const exhaustive: never = value
      void exhaustive
    }
  }
}
void receiveRole

function receiveTextureType(value: TextureType) {
  switch (value) {
    case 'steve':
    case 'alex':
    case 'cape':
      return
    default: {
      // @ts-expect-error 覆盖已知成员后仍须处理次版本新增的值
      const exhaustive: never = value
      void exhaustive
    }
  }
}
void receiveTextureType

function receiveUserField(value: CoreEvents['user.profileUpdated']['fields'][number]) {
  switch (value) {
    case 'nickname':
    case 'email':
    case 'password':
    case 'avatar':
    case 'locale':
      return
    default: {
      // @ts-expect-error 覆盖已知成员后仍须处理次版本新增的值
      const exhaustive: never = value
      void exhaustive
    }
  }
}
void receiveUserField

function receiveTextureField(value: CoreEvents['texture.updated']['fields'][number]) {
  switch (value) {
    case 'name':
    case 'type':
    case 'public':
    case 'description':
      return
    default: {
      // @ts-expect-error 覆盖已知成员后仍须处理次版本新增的值
      const exhaustive: never = value
      void exhaustive
    }
  }
}
void receiveTextureField

function receiveResolution(value: CoreEvents['report.resolved']['action']) {
  switch (value) {
    case 'dismissed':
    case 'textureDeleted':
    case 'uploaderBanned':
      return
    default: {
      // @ts-expect-error 覆盖已知成员后仍须处理次版本新增的值
      const exhaustive: never = value
      void exhaustive
    }
  }
}
void receiveResolution

// @ts-expect-error 服务端入口不能省略
const absentServer: PluginManifest['entry'] = {}
void absentServer

// @ts-expect-error 提取出的清单也要求 detect 至少一项
const emptyManifestDetect: PluginManifest['providers']['passwordHasher'][number]['detect'] = {}
void emptyManifestDetect

// 密码和同意选项不能从地址栏预填；每个 definePlugin 只有一个结构性错误。
definePlugin({
  capabilities: [],
  ui: {
    formFields: [
      // @ts-expect-error password 不能 fromQuery: true
      { form: 'auth.register', field: { type: 'password', name: 'password', label: 'password' }, fromQuery: true },
    ],
  },
})
definePlugin({
  capabilities: [],
  ui: {
    formFields: [
      // @ts-expect-error boolean 不能 fromQuery: true
      { form: 'auth.register', field: { type: 'boolean', name: 'accept', label: 'accept' }, fromQuery: true },
    ],
  },
})
definePlugin({
  capabilities: [],
  ui: {
    formFields: [
      { form: 'auth.register', field: { type: 'text', name: 'code', label: 'code' }, fromQuery: true },
      { form: 'auth.register', field: { type: 'textarea', name: 'note', label: 'note' }, fromQuery: true },
      { form: 'auth.register', field: { type: 'number', name: 'n', label: 'n' }, fromQuery: true },
      {
        form: 'auth.register',
        field: { type: 'select', name: 's', label: 's', options: [{ value: 'a', label: 'a' }] },
        fromQuery: true,
      },
      { form: 'auth.register', field: { type: 'boolean', name: 'accept', label: 'accept' }, fromQuery: false },
    ],
  },
})

// 事务外的签发拦截器有完整上下文，via 允许次版本扩展，仍然只能拒绝。
definePlugin({
  capabilities: ['storage.kv'],
  intercept: {
    'yggdrasil.issueToken': async ({ input, ctx }) => {
      if (input.via === 'authenticate') await ctx.kv.set(String(input.uid), true)
      void ctx.fetch
      void ctx.jobs
    },
  },
})
definePlugin({
  capabilities: [],
  intercept: {
    // @ts-expect-error 签发拦截器不能返回 patch
    'yggdrasil.issueToken': async () => ({ action: 'patch', patch: {} }),
  },
})

// 用户操作拦截器在事务外运行，action 允许次版本扩展，不能返回 patch。
definePlugin({
  capabilities: ['storage.kv'],
  intercept: {
    'user.action': async ({ input, ctx }) => {
      if (input.action === 'texture.upload') await ctx.kv.set(String(input.uid), true)
      void ctx.fetch
      void ctx.jobs
    },
  },
})
definePlugin({
  capabilities: [],
  intercept: {
    // @ts-expect-error 用户操作拦截器不能返回 patch
    'user.action': async () => ({ action: 'patch', patch: {} }),
  },
})

// 通知能力只在申请后出现，事务内仍不可用（ADR-0052）。
definePlugin({
  capabilities: [],
  on: {
    'user.registered': async ({ ctx }) => {
      // @ts-expect-error notifications 需要 notifications.send
      ctx.notifications
    },
  },
})
definePlugin({
  capabilities: ['notifications.send'],
  intercept: {
    'user.register': async ({ ctx }) => {
      // @ts-expect-error 事务内没有 notifications
      ctx.notifications
    },
  },
})
definePlugin({
  capabilities: ['notifications.send'],
  on: {
    'user.registered': async ({ ctx, event }) => {
      const result = await ctx.notifications.send(
        event.data.user.uid,
        {
          title: 'notice.title',
          body: 'notice.body',
          params: { name: 'Alex', count: 1 },
          link: '/user',
        },
        { key: 'once' },
      )
      const status: string = result.status
      void status
      await ctx.notifications.send(event.data.user.uid, { title: 'notice.title' }, { key: 'minimal' })
    },
  },
})
