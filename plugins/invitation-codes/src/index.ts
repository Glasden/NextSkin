/**
 * 邀请码注册（对应 BS 的 invitation-codes 插件）。
 *
 * 注册表单多一个邀请码字段；注册事务里用一条带条件的 UPDATE 把码标成已用，
 * 码无效就拒绝注册。这条写入随注册一起提交或回滚，不会出现"码作废了、用户没建成"。
 * 用户建好之后，`user.registered` 事件再把用户 id 记到码上。
 */
import { definePlugin, deny, table, z, type TableSourceResponse } from '@nextskin/plugin-sdk'

interface CodeRow {
  code: string
  status: 'unused' | 'used'
  used_by: number | null
  used_at: string | null
  created_by: number
  /** 插件表的时间一律存 ISO 字符串：四种数据库的日期类型行为不一致 */
  created_at: string
  expires_at: string | null
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 12
const MAX_PAGE_SIZE = 100

/** 32 个字符，256 能整除，取模没有偏差 */
export function randomCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (byte) => ALPHABET[byte % 32]).join('')
}

/** 用户输入的码：去掉空白和连字符，转大写 */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase()
}

const generateBody = z.object({
  count: z.coerce.number().int().min(1).max(100),
  expiresInDays: z
    .union([z.literal(''), z.coerce.number().int().min(0).max(3650)])
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
})

export default definePlugin({
  capabilities: ['storage.tables'],
  settings: z.object({
    /** 生成时不填有效期就用这个，0 表示永不过期 */
    defaultExpiresInDays: z.number().int().min(0).max(3650).default(0),
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
          .addColumn('used_at', 'varchar(32)')
          .addColumn('created_by', 'integer', (col) => col.notNull())
          .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
          .addColumn('expires_at', 'varchar(32)')
          .execute()
        await db.schema.createIndex('codes_created_at').on('codes').column('created_at').execute()
      },
    },
  },

  ui: {
    formFields: [
      {
        form: 'auth.register',
        field: {
          name: 'code',
          type: 'text',
          label: 'field.code',
          help: 'field.codeHelp',
          required: true,
          maxLength: 32,
        },
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
          searchable: true,
          columns: [
            { key: 'code', label: 'column.code', format: 'code' },
            { key: 'status', label: 'column.status', format: 'status' },
            { key: 'used_by', label: 'column.usedBy', format: 'user' },
            { key: 'created_at', label: 'column.createdAt', format: 'datetime' },
            { key: 'expires_at', label: 'column.expiresAt', format: 'datetime' },
          ],
          toolbar: [
            {
              label: 'action.generate',
              method: 'POST',
              route: '/codes',
              form: [
                { name: 'count', type: 'number', label: 'field.count', help: 'field.countHelp', required: true },
                {
                  name: 'expiresInDays',
                  type: 'number',
                  label: 'field.expiresInDays',
                  help: 'field.expiresInDaysHelp',
                },
              ],
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
    nav: [{ area: 'admin', page: 'codes', label: 'page.codes', icon: 'mail' }],
  },

  intercept: {
    'user.register': async ({ input, ctx }) => {
      const now = new Date().toISOString()
      const result = await ctx.db
        .updateTable('codes')
        .set({ status: 'used', used_at: now })
        .where('code', '=', normalizeCode(input.extra.code ?? ''))
        .where('status', '=', 'unused')
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .executeTakeFirst()
      if (result.numUpdatedRows === 0n) return deny('invalid_code', ctx.t('error.invalidCode'))
    },
  },

  on: {
    // 至少一次投递：写的是同一个值，重复执行没有影响
    'user.registered': async ({ event, ctx }) => {
      const code = event.data.extra.code
      if (!code) return
      await ctx.db
        .updateTable('codes')
        .set({ used_by: event.data.user.uid })
        .where('code', '=', normalizeCode(code))
        .where('used_by', 'is', null)
        .execute()
    },
  },

  routes: {
    'GET /codes': {
      auth: 'user',
      permission: 'manage',
      async handler({ request, scope, ctx }) {
        const url = new URL(request.url)
        const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page')) || 1))
        const pageSize = Math.min(
          MAX_PAGE_SIZE,
          Math.max(1, Math.trunc(Number(url.searchParams.get('pageSize')) || 20)),
        )
        const q = normalizeCode(url.searchParams.get('q') ?? '')
        let query = ctx.db.selectFrom('codes')
        if (q) query = query.where('code', 'like', `%${q.replace(/[^A-Z0-9]/g, '')}%`)
        const [rows, count] = await Promise.all([
          query
            .selectAll()
            .orderBy('created_at', 'desc')
            .orderBy('code')
            .limit(pageSize)
            .offset((page - 1) * pageSize)
            .execute(),
          query.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow(),
        ])
        const now = new Date().toISOString()
        const status = (row: CodeRow) =>
          ctx.t(
            row.status === 'used'
              ? 'status.used'
              : row.expires_at !== null && row.expires_at <= now
                ? 'status.expired'
                : 'status.unused',
            undefined,
            scope.locale,
          )
        return Response.json({
          rows: rows.map((row) => ({
            code: row.code,
            status: status(row),
            used_by: row.used_by,
            created_at: row.created_at,
            expires_at: row.expires_at,
          })),
          // count 在不同数据库里可能是 number、string 或 bigint，一律 Number()
          total: Number(count.total),
        } satisfies TableSourceResponse)
      },
    },

    'POST /codes': {
      auth: 'user',
      permission: 'manage',
      maxBodyBytes: 1024,
      async handler({ request, scope, ctx }) {
        const parsed = generateBody.safeParse(await request.json().catch(() => null))
        if (!parsed.success)
          return Response.json({ error: ctx.t('error.invalidCount', undefined, scope.locale) }, { status: 400 })
        const days = parsed.data.expiresInDays ?? ctx.settings.defaultExpiresInDays
        const now = new Date()
        const rows = Array.from({ length: parsed.data.count }, () => ({
          code: randomCode(),
          status: 'unused' as const,
          used_by: null,
          used_at: null,
          created_by: scope.actor.uid,
          created_at: now.toISOString(),
          expires_at: days > 0 ? new Date(now.getTime() + days * 86_400_000).toISOString() : null,
        }))
        await ctx.db.insertInto('codes').values(rows).execute()
        ctx.log.info('generated invitation codes', { count: rows.length, by: scope.actor.uid })
        return Response.json({ created: rows.length }, { status: 201 })
      },
    },

    'DELETE /codes/:code': {
      auth: 'user',
      permission: 'manage',
      async handler({ params, ctx }) {
        await ctx.db
          .deleteFrom('codes')
          .where('code', '=', params.code ?? '')
          .execute()
        return new Response(null, { status: 204 })
      },
    },
  },
})
