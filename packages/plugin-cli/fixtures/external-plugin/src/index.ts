/**
 * test:pack 用的插件（ADR-0035）：只依赖发布出去的两个包，在仓库外照插件作者的方式安装、类型检查、构建。
 * 覆盖公开面里常用的部分，声明文件有问题时在这里先暴露出来
 */
import { definePlugin, deny, secret, table, z, type TableSourceResponse } from '@nextskin/plugin-sdk'

type NoteRow = {
  id: string
  uid: number
  body: string
  /** 插件表的时间存 ISO 字符串 */
  created_at: string
}

export default definePlugin({
  capabilities: ['users.read', 'storage.kv', 'storage.tables'],
  network: ['https://api.example.com'],
  settings: z.object({
    token: secret(),
    days: z.number().int().min(1).max(365).default(30),
  }),
  permissions: { manage: 'permission.manage' },
  tables: { notes: table<NoteRow>() },
  migrations: {
    '0001_create_notes': {
      async up(db) {
        await db.schema
          .createTable('notes')
          .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
          .addColumn('uid', 'integer', (column) => column.notNull())
          .addColumn('body', 'text', (column) => column.notNull())
          .addColumn('created_at', 'varchar(32)', (column) => column.notNull())
          .execute()
      },
    },
  },
  on: {
    'user.registered': async ({ event, ctx }) => {
      await ctx.kv.set(`welcome:${event.data.user.uid}`, event.data.user.nickname, { ttlSec: 3600 })
    },
  },
  intercept: {
    'user.register': async ({ input, ctx }) => {
      if (input.nickname.startsWith('bot')) return deny('bot_nickname', ctx.t('error.bot'))
    },
  },
  routes: {
    'GET /notes': {
      auth: 'user',
      permission: 'manage',
      async handler({ request, ctx }) {
        const q = new URL(request.url).searchParams.get('q')?.trim()
        let query = ctx.db.selectFrom('notes').selectAll()
        if (q) {
          const authors = await ctx.users.searchByNickname(q, { limit: 100 })
          if (!authors.length) return Response.json({ rows: [], total: 0 } satisfies TableSourceResponse)
          query = query.where(
            'uid',
            'in',
            authors.map((author) => author.uid),
          )
        }
        const rows = await query.orderBy('created_at', 'desc').limit(20).execute()
        const users = await ctx.users.getMany(rows.map((row) => row.uid))
        ctx.log.info('notes listed', { count: rows.length, users: users.length })
        const body: TableSourceResponse = { rows, total: rows.length }
        return Response.json(body)
      },
    },
    'POST /ping': {
      auth: 'public',
      rateLimit: { limit: 10, windowSec: 60, by: 'ip' },
      async handler({ ctx }) {
        const response = await ctx.fetch('https://api.example.com/ping', {
          method: 'POST',
          headers: { authorization: `Bearer ${ctx.settings.token}` },
          body: '{}',
        })
        return new Response(null, { status: response.ok ? 204 : 502 })
      },
    },
  },
  jobs: {
    cleanup: {
      async handler({ ctx }) {
        const before = new Date(Date.now() - ctx.settings.days * 86_400_000).toISOString()
        await ctx.db.deleteFrom('notes').where('created_at', '<', before).execute()
      },
    },
  },
  cron: [{ schedule: '0 3 * * *', job: 'cleanup' }],
  ui: {
    nav: [{ area: 'admin', page: 'notes', label: 'nav.notes', icon: 'note' }],
    pages: {
      notes: {
        area: 'admin',
        title: 'nav.notes',
        permission: 'manage',
        view: {
          kind: 'table',
          source: '/notes',
          columns: [
            { key: 'uid', label: 'column.user', format: 'user' },
            { key: 'body', label: 'column.body' },
          ],
        },
      },
    },
  },
})
