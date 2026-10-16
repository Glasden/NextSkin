/**
 * 类型层面的契约测试：这些 @ts-expect-error 一旦不再报错，说明 SDK 的约束被放松了。
 * 由 `tsc --noEmit` 执行。
 *
 * 注意：同一个 definePlugin 调用的对象字面量里只放一个结构性错误。
 * TypeScript 对一个参数只报告第一处不可赋值，多放的 @ts-expect-error 会被误判为"未使用"。
 */
import { definePlugin, deny, patch, table, z } from '@nextskin/plugin-sdk'

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
      // @ts-expect-error adjustScore 需要 users.score
      ctx.users.adjustScore
    },
  },
})

// 只申请 users.score 时，users 上只有 adjustScore。
definePlugin({
  capabilities: ['users.score'],
  on: {
    'closet.itemAdded': async ({ event, ctx }) => {
      await ctx.users.adjustScore(event.data.uid, 1, 'reason.closet')
      // @ts-expect-error 没有 users.read
      ctx.users.get
    },
  },
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

// 不允许修改的拦截点不能返回 patch；可修改的拦截点只能改白名单字段。
definePlugin({
  capabilities: [],
  intercept: {
    // @ts-expect-error player.create 不接受 patch
    'player.create': async () => patch({ name: 'x' }),
    'user.register': async ({ input }) => {
      if (input.nickname.length > 20) return patch({ nickname: input.nickname.slice(0, 20) })
      if (input.email.endsWith('@example.com')) return deny('blocked_domain', '不支持该邮箱域名')
    },
  },
})
definePlugin({
  capabilities: [],
  intercept: {
    // @ts-expect-error email 不在 user.register 的可修改字段里
    'user.register': async () => patch({ email: 'x@y.z' }),
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
        // @ts-expect-error 公开路由的 actor 可能不是用户
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
