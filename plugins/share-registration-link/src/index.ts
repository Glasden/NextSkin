/**
 * 分享注册链接（对应 BS 的 share-registration-link）。
 *
 * 用户在用户中心生成分享码，把带分享码的注册链接发给别人。新用户经这个链接注册后，
 * 分享人和新用户各得一笔积分。分享码无效时照样注册，只是没有奖励。
 */
import { definePlugin, table, z, type PluginContext, type TableSourceResponse } from '@nextskin/plugin-sdk'

interface CodeRow {
  code: string
  uid: number
  created_at: string
}

/** 每个新用户一行。积分在这里先记下来，重试时按记下的分数发，管理员中途改了设置也不会变 */
interface RewardRow {
  sharee_uid: number
  sharer_uid: number
  code: string
  sharer_score: number
  sharee_score: number
  /** pending：还没占名额；granted：占到了，积分按 key 发（重复发是 duplicate）；capped：分享人的名额满了 */
  state: 'pending' | 'granted' | 'capped'
  /** 占到的是分享人的第几个名额。(sharer_uid, slot) 唯一，并发的两次注册抢同一个名额时只有一个成功 */
  slot: number | null
  created_at: string
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 16
const MAX_CODES_PER_USER = 10

/** 32 个字符，256 能整除，取模没有偏差 */
export function randomCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (byte) => ALPHABET[byte % 32]).join('')
}

/** 用户输入的码：去掉空白和连字符，转大写 */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase()
}

const capabilities = ['storage.tables', 'users.score'] as const
const settings = z.object({
  sharerScore: z.number().int().min(0).max(1_000_000).default(50),
  shareeScore: z.number().int().min(0).max(1_000_000).default(0),
  /** 0 表示不限 */
  maxRewardsPerSharer: z.number().int().min(0).max(1_000_000).default(0),
})
const tables = { codes: table<CodeRow>(), rewards: table<RewardRow>() }
type Ctx = PluginContext<typeof capabilities, z.output<typeof settings>, typeof tables>

export default definePlugin({
  capabilities,
  settings,
  tables,
  migrations: {
    '0001_create_tables': {
      async up(db) {
        await db.schema
          .createTable('codes')
          .addColumn('code', 'varchar(32)', (col) => col.primaryKey())
          .addColumn('uid', 'integer', (col) => col.notNull())
          .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
          .execute()
        await db.schema.createIndex('codes_uid').on('codes').column('uid').execute()
        await db.schema
          .createTable('rewards')
          .addColumn('sharee_uid', 'integer', (col) => col.primaryKey())
          .addColumn('sharer_uid', 'integer', (col) => col.notNull())
          .addColumn('code', 'varchar(32)', (col) => col.notNull())
          .addColumn('sharer_score', 'integer', (col) => col.notNull())
          .addColumn('sharee_score', 'integer', (col) => col.notNull())
          .addColumn('state', 'varchar(16)', (col) => col.notNull())
          .addColumn('slot', 'integer')
          .addColumn('created_at', 'varchar(32)', (col) => col.notNull())
          .addUniqueConstraint('rewards_sharer_slot', ['sharer_uid', 'slot'])
          .execute()
        await db.schema.createIndex('rewards_code').on('rewards').column('code').execute()
      },
    },
  },

  ui: {
    formFields: [
      {
        form: 'auth.register',
        fromQuery: true,
        field: { name: 'code', type: 'text', label: 'field.code', help: 'field.codeHelp', maxLength: 32 },
      },
    ],
    pages: {
      links: {
        area: 'user',
        title: 'page.links',
        view: {
          kind: 'table',
          source: '/codes',
          columns: [
            { key: 'link', label: 'column.link', format: 'code' },
            { key: 'registrations', label: 'column.registrations', format: 'number' },
            { key: 'created_at', label: 'column.createdAt', format: 'datetime' },
          ],
          toolbar: [{ label: 'action.generate', method: 'POST', route: '/codes' }],
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
    nav: [{ area: 'user', page: 'links', label: 'page.links', icon: 'link' }],
    widgets: [
      {
        name: 'share',
        slot: 'user.dashboard',
        title: 'widget.title',
        link: { page: 'links', label: 'widget.manage' },
        view: { kind: 'markdown', source: '/widget' },
      },
    ],
  },

  on: {
    // 至少一次投递：每一步都能重跑，积分按 key 只记一次
    'user.registered': async ({ event, ctx }) => {
      const code = normalizeCode(event.data.extra.code ?? '')
      if (!code) return
      const reward = await recordReward(ctx, code, event.data.user.uid)
      if (!reward) return
      if (reward.state === 'capped') return
      if (reward.state === 'pending' && !(await claimSlot(ctx, reward))) return
      await grant(ctx, reward.sharer_uid, reward.sharer_score, 'score.sharer', `sharer:${reward.sharee_uid}`)
      await grant(ctx, reward.sharee_uid, reward.sharee_score, 'score.sharee', `sharee:${reward.sharee_uid}`)
    },
    'user.deleted': async ({ event, ctx }) => {
      // 奖励记录留着：删掉的话，分享人删号重来就能把名额刷回来
      await ctx.db.deleteFrom('codes').where('uid', '=', event.data.uid).execute()
    },
  },

  routes: {
    'GET /widget': {
      auth: 'user',
      async handler({ request, scope, ctx }) {
        const { sharerScore, shareeScore, maxRewardsPerSharer } = ctx.settings
        if (sharerScore === 0 && shareeScore === 0) return new Response(null, { status: 204 })
        const paragraphs = [
          ctx.t(
            sharerScore > 0 && shareeScore > 0 ? 'widget.both' : sharerScore > 0 ? 'widget.sharer' : 'widget.sharee',
            { sharer: sharerScore, sharee: shareeScore },
            scope.locale,
          ),
        ]
        if (maxRewardsPerSharer > 0) {
          const { total } = await ctx.db
            .selectFrom('rewards')
            .select((eb) => eb.fn.countAll().as('total'))
            .where('sharer_uid', '=', scope.actor.uid)
            .where('slot', 'is not', null)
            .executeTakeFirstOrThrow()
          const left = maxRewardsPerSharer - Number(total)
          paragraphs.push(
            ctx.t(left > 0 ? 'widget.left' : 'widget.capped', { left, max: maxRewardsPerSharer }, scope.locale),
          )
        }
        const latest = await ctx.db
          .selectFrom('codes')
          .select('code')
          .where('uid', '=', scope.actor.uid)
          .orderBy('created_at', 'desc')
          .orderBy('code')
          .limit(1)
          .executeTakeFirst()
        if (latest) {
          const site = ctx.site.url || new URL(request.url).origin
          paragraphs.push(
            `${ctx.t('widget.latest', undefined, scope.locale)}\n\`\`\`\n${registerLink(site, ctx.plugin.id, latest.code)}\n\`\`\``,
          )
          const { total } = await ctx.db
            .selectFrom('rewards')
            .select((eb) => eb.fn.countAll().as('total'))
            .where('sharer_uid', '=', scope.actor.uid)
            .executeTakeFirstOrThrow()
          const count = Number(total)
          paragraphs.push(ctx.t(count ? 'widget.registrations' : 'widget.noRegistrations', { count }, scope.locale))
        } else {
          paragraphs.push(ctx.t('widget.none', undefined, scope.locale))
        }
        return new Response(paragraphs.join('\n\n'), { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
      },
    },
    'GET /codes': {
      auth: 'user',
      async handler({ request, scope, ctx }) {
        const rows = await ctx.db
          .selectFrom('codes')
          .selectAll()
          .where('uid', '=', scope.actor.uid)
          .orderBy('created_at', 'desc')
          .orderBy('code')
          .execute()
        const counts = rows.length
          ? await ctx.db
              .selectFrom('rewards')
              .select((eb) => ['code', eb.fn.countAll().as('total')])
              .where(
                'code',
                'in',
                rows.map((row) => row.code),
              )
              .groupBy('code')
              .execute()
          : []
        const registrations = new Map(counts.map((row) => [row.code, Number(row.total)]))
        // 管理员没填站点地址时 site.url 是空串，退回请求的地址（核心按用户看到的地址构造）
        const site = ctx.site.url || new URL(request.url).origin
        return Response.json({
          rows: rows.map((row) => ({
            code: row.code,
            link: registerLink(site, ctx.plugin.id, row.code),
            registrations: registrations.get(row.code) ?? 0,
            created_at: row.created_at,
          })),
          total: rows.length,
        } satisfies TableSourceResponse)
      },
    },

    'POST /codes': {
      auth: 'user',
      rateLimit: { limit: 20, windowSec: 60, by: 'user' },
      async handler({ scope, ctx }) {
        const { total } = await ctx.db
          .selectFrom('codes')
          .select((eb) => eb.fn.countAll().as('total'))
          .where('uid', '=', scope.actor.uid)
          .executeTakeFirstOrThrow()
        // 先数再插不是原子的，同一个人并发点几下可能多出一两个，无关紧要
        if (Number(total) >= MAX_CODES_PER_USER)
          return Response.json(
            { error: ctx.t('error.tooMany', { max: MAX_CODES_PER_USER }, scope.locale) },
            { status: 409 },
          )
        await ctx.db
          .insertInto('codes')
          .values({ code: randomCode(), uid: scope.actor.uid, created_at: new Date().toISOString() })
          .execute()
        return new Response(null, { status: 201 })
      },
    },

    'DELETE /codes/:code': {
      auth: 'user',
      async handler({ params, scope, ctx }) {
        await ctx.db
          .deleteFrom('codes')
          .where('code', '=', params.code ?? '')
          .where('uid', '=', scope.actor.uid)
          .execute()
        return new Response(null, { status: 204 })
      },
    },
  },
})

/** 给新用户记一行奖励，已经记过就返回那一行；分享码不存在时返回 null */
async function recordReward(ctx: Ctx, code: string, sharee: number): Promise<RewardRow | null> {
  const existing = await findReward(ctx, sharee)
  if (existing) return existing
  const owner = await ctx.db.selectFrom('codes').select('uid').where('code', '=', code).executeTakeFirst()
  if (!owner || owner.uid === sharee) return null
  const row: RewardRow = {
    sharee_uid: sharee,
    sharer_uid: owner.uid,
    code,
    sharer_score: ctx.settings.sharerScore,
    sharee_score: ctx.settings.shareeScore,
    state: 'pending',
    slot: null,
    created_at: new Date().toISOString(),
  }
  try {
    await ctx.db.insertInto('rewards').values(row).execute()
    return row
  } catch (error) {
    // 同一个事件的另一次投递先插进去了
    const raced = await findReward(ctx, sharee)
    if (raced) return raced
    throw error
  }
}

function findReward(ctx: Ctx, sharee: number) {
  return ctx.db.selectFrom('rewards').selectAll().where('sharee_uid', '=', sharee).executeTakeFirst()
}

/**
 * 占分享人的下一个名额，占到了（包括别的投递已经替它占到）返回 true。名额按 slot 编号，(sharer_uid, slot) 唯一：
 * 并发的两次注册算出同一个编号时，后写的那次违反唯一约束、抛错，事件稍后重投时重新数
 */
async function claimSlot(ctx: Ctx, reward: RewardRow): Promise<boolean> {
  const { total } = await ctx.db
    .selectFrom('rewards')
    .select((eb) => eb.fn.countAll().as('total'))
    .where('sharer_uid', '=', reward.sharer_uid)
    .where('slot', 'is not', null)
    .executeTakeFirstOrThrow()
  const used = Number(total)
  const max = ctx.settings.maxRewardsPerSharer
  const state = max > 0 && used >= max ? 'capped' : 'granted'
  await ctx.db
    .updateTable('rewards')
    .set(state === 'granted' ? { state, slot: used + 1 } : { state })
    .where('sharee_uid', '=', reward.sharee_uid)
    .where('state', '=', 'pending')
    .execute()
  // 同一个事件的另一次投递可能抢先改了这一行，以库里的为准
  const current = await findReward(ctx, reward.sharee_uid)
  return current?.state === 'granted'
}

async function grant(ctx: Ctx, uid: number, score: number, reason: string, key: string) {
  if (score === 0) return
  const result = await ctx.users.adjustScore(uid, score, { reason, key })
  // 用户已经删了就算了；applied、duplicate 都是记上了
  if (result.status !== 'applied' && result.status !== 'duplicate' && result.status !== 'userNotFound')
    ctx.log.warn('score not granted', { uid, status: result.status })
}

/** 站点地址可能带路径（装在子目录里），不能用 new URL('/sign-up', base) */
export function registerLink(siteUrl: string, pluginId: string, code: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/sign-up?${new URLSearchParams({ [`${pluginId}.code`]: code }).toString()}`
}
