/**
 * 示例：邀请码注册（对应旧版 invitation-codes 插件）。
 *
 * 演示：设置项、插件权限、自有表与迁移、往注册表单追加字段、
 * 事务内拦截器、事务后事件、声明式后台页面、插件路由。
 * 旧版需要 Twig 模板 + 注入 JS 才能做到的事，这里一行 HTML 都不用写。
 */
import { definePlugin, deny, table, z, type TableSourceResponse } from '@nextskin/plugin-sdk'

interface CodeRow {
  code: string
  status: 'unused' | 'used'
  used_by: number | null
  created_by: number
  /** 插件表的时间一律存 ISO 字符串：三种数据库的日期类型行为不一致 */
  created_at: string
}

export default definePlugin({
  capabilities: ['storage.tables'],
  settings: z.object({
    required: z.boolean().default(true),
  }),
  permissions: { manage: 'permission.manage' },
  tables: { codes: table<CodeRow>() },
  migrations: {
    '0001_create_codes': {
      async up(db) {
        await db.schema
          .createTable('codes')
          .addColumn('code', 'varchar(32)', (col) => col.primaryKey())
          .addColumn('status', 'varchar(16)', (col) => col.notNull())
          .addColumn('used_by', 'integer')
          .addColumn('created_by', 'integer', (col) => col.notNull())
          .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
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
    pages: {
      codes: {
        area: 'admin',
        title: 'page.codes',
        permission: 'manage',
        view: {
          kind: 'table',
          source: '/codes',
          columns: [
            { key: 'code', label: 'column.code', format: 'code' },
            { key: 'status', label: 'column.status', format: 'status' },
            { key: 'used_by', label: 'column.usedBy', format: 'user' },
            { key: 'created_at', label: 'column.createdAt', format: 'datetime' },
          ],
          toolbar: [
            {
              label: 'action.generate',
              method: 'POST',
              route: '/codes',
              form: [{ name: 'count', type: 'number', label: 'field.count', required: true }],
            },
          ],
          rowActions: [
            {
              label: 'action.delete',
              method: 'DELETE',
              route: '/codes/:code',
              tone: 'danger',
              confirm: 'confirm.delete',
            },
          ],
        },
      },
    },
    nav: [{ area: 'admin', page: 'codes', label: 'page.codes', icon: 'ticket' }],
  },

  intercept: {
    // 在注册事务内执行：这里的写入随注册一起提交或回滚，不会出现"码已作废但用户没建成"。
    'user.register': async ({ input, ctx }) => {
      if (!ctx.settings.required) return
      const result = await ctx.db
        .updateTable('codes')
        .set({ status: 'used' })
        .where('code', '=', input.extra.code ?? '')
        .where('status', '=', 'unused')
        .executeTakeFirst()
      if (result.numUpdatedRows === 0n) return deny('invalid_code', ctx.t('error.invalidCode'))
    },
  },

  on: {
    // 事务提交后、至少一次投递：这个写入天然幂等。
    'user.registered': async ({ event, ctx }) => {
      const code = event.data.extra.code
      if (!code) return
      await ctx.db.updateTable('codes').set({ used_by: event.data.user.uid }).where('code', '=', code).execute()
    },
  },

  routes: {
    'GET /codes': {
      auth: 'user',
      permission: 'manage',
      async handler({ request, ctx }) {
        const url = new URL(request.url)
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
        const pageSize = 20
        const rows = await ctx.db
          .selectFrom('codes')
          .selectAll()
          .orderBy('created_at', 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .execute()
        const { total } = await ctx.db
          .selectFrom('codes')
          .select((eb) => eb.fn.countAll().as('total'))
          .executeTakeFirstOrThrow()
        // count 在不同数据库里可能是 number、string 或 bigint，一律 Number()
        return Response.json({ rows, total: Number(total) } satisfies TableSourceResponse)
      },
    },

    'POST /codes': {
      auth: 'user',
      permission: 'manage',
      async handler({ request, scope, ctx }) {
        const { count } = z
          .object({ count: z.coerce.number().int().min(1).max(100) })
          .parse(await request.json())
        const now = new Date().toISOString()
        const rows = Array.from({ length: count }, () => ({
          code: randomCode(),
          status: 'unused' as const,
          used_by: null,
          created_by: scope.actor.uid,
          created_at: now,
        }))
        await ctx.db.insertInto('codes').values(rows).execute()
        return Response.json({ created: rows.length }, { status: 201 })
      },
    },

    'DELETE /codes/:code': {
      auth: 'user',
      permission: 'manage',
      async handler({ params, ctx }) {
        await ctx.db.deleteFrom('codes').where('code', '=', params.code ?? '').execute()
        return new Response(null, { status: 204 })
      },
    },
  },
})

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomCode(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
