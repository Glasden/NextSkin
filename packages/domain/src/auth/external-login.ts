/**
 * 第三方登录（ADR-0034）：发起、回调、首次登录、绑定和解绑。和第三方交换身份由 login 插件完成（plugins/system.ts），
 * 签发会话由 Better Auth 完成（auth/external-session.ts），这里只管状态和数据。
 *
 * - 绑定存在 accounts：`provider_id` 是 `plugin:<插件 id>:<Provider id>`，`account_id` 是 subject，令牌各列留空。
 *   `(provider_id, account_id)` 和 `(user_id, provider_id)` 各有唯一索引。
 * - state 和"完成注册"之前暂存的身份存在 verifications 里，键是随机值的 sha256；随机值本身放在 HttpOnly 的 Cookie 里，
 *   回调时两者对上才继续，所以别的浏览器拿到回调地址也用不了。state 用一次就删。
 * - 调插件、发网络请求都在事务之外，事务里只写绑定或注册（ADR-0008）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  countRows,
  insertOrIgnore,
  readAuthDate,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { matchLocale } from '@nextskin/i18n'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { DomainError } from '../errors.ts'
import { MAIL_JOB, type MailService } from '../mail/service.ts'
import type { JobRunner } from '../jobs/runner.ts'
import type { ExternalIdentity, LoginProviderEntry, PluginSystem } from '../plugins/system.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import { lockUser } from '../users/lock.ts'
import type { RegisterInput } from '../users/register.ts'

/** state 的有效期：用户在第三方的授权页上停留的时间 */
export const EXTERNAL_STATE_TTL_SECONDS = 10 * 60
/** "完成注册"页上暂存的身份的有效期 */
export const EXTERNAL_PENDING_TTL_SECONDS = 30 * 60

export type ExternalLoginIntent = 'signIn' | 'link'

export const bindingProviderId = (pluginId: string, providerId: string) => `plugin:${pluginId}:${providerId}`

/** 回调地址：管理员要把它原样填到第三方的控制台，改了它所有站点都要重填（ADR-0034） */
export const externalCallbackPath = (pluginId: string, providerId: string) =>
  `/api/external-login/${encodeURIComponent(pluginId)}/${encodeURIComponent(providerId)}/callback`

const stateKey = (value: string) => `external-login:state:${sha256(value)}`
const pendingKey = (value: string) => `external-login:pending:${sha256(value)}`

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function random(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const stateSchema = z.object({
  pluginId: z.string(),
  providerId: z.string(),
  intent: z.enum(['signIn', 'link']),
  /** 发起绑定的用户：回调时当前会话必须还是他 */
  uid: z.number().int().nullable(),
  /**
   * 发起绑定的那个会话（Better Auth 的会话 id）：回调时必须还是它，写绑定时在锁内确认它还在（ADR-0036）。
   * 加这个字段之前签发的 state 没有它，那样的绑定按过期处理
   */
  sessionId: z.number().int().nullable().optional(),
  next: z.string(),
  codeVerifier: z.string(),
})
type StateRecord = z.infer<typeof stateSchema>

const pendingSchema = z.object({
  pluginId: z.string(),
  providerId: z.string(),
  subject: z.string(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  displayName: z.string().nullable(),
  next: z.string(),
})
type PendingRecord = z.infer<typeof pendingSchema>

/** 回调的结果：调用方按它签发会话、写 Cookie、跳转 */
export type ExternalCallbackResult =
  | { kind: 'signedIn'; uid: number; next: string }
  | { kind: 'linked'; next: string }
  | { kind: 'register'; pendingToken: string; next: string }

/** 第三方给的邮箱：格式不对、太长就当作没给，用户在"完成注册"页上自己填 */
function normalizeEmail(email: string | null): string | null {
  if (email === null) return null
  const value = email.trim().toLowerCase()
  return value.length <= 255 && z.email().safeParse(value).success ? value : null
}

/**
 * 登录页上能用的第三方，按绑定的 provider_id 写。要在事务之外读：读插件设置用的是 db，SQLite 只有一个连接。
 * 后台的删通行密钥、解绑也用它（ADR-0036）
 */
export async function usableBindings(plugins: Pick<PluginSystem, 'loginProviders'>): Promise<Set<string>> {
  return new Set((await plugins.loginProviders()).map((item) => bindingProviderId(item.pluginId, item.providerId)))
}

/** `plugin:<插件 id>:<Provider id>` 拆回两段；不是第三方绑定时返回 null */
export function parseBindingProviderId(value: string): { pluginId: string; providerId: string } | null {
  if (!value.startsWith('plugin:')) return null
  const rest = value.slice('plugin:'.length)
  const index = rest.indexOf(':')
  return index < 0 ? null : { pluginId: rest.slice(0, index), providerId: rest.slice(index + 1) }
}

/**
 * 这个用户现在还有没有能用的登录方式：密码、通行密钥，或者绑在登录页上能用的第三方（usable）上（ADR-0034）。
 * excluded 挑出不算数的绑定（正要解绑的那个）；withoutPasskeys 不算通行密钥（后台正要把它们全部删掉）。
 * 调用方在事务里时传 tx，并且已经锁住用户行
 */
export async function hasLoginMethod(
  executor: Kysely<CoreDatabase>,
  uid: number,
  usable: ReadonlySet<string>,
  options: { excluded?: (providerId: string) => boolean; withoutPasskeys?: boolean } = {},
): Promise<boolean> {
  const excluded = options.excluded ?? (() => false)
  const accounts = await executor
    .selectFrom('accounts')
    .select(['provider_id', 'password'])
    .where('user_id', '=', uid)
    .execute()
  if (accounts.some((account) => account.provider_id === 'credential' && account.password)) return true
  if (!options.withoutPasskeys && (await countRows(executor.selectFrom('passkeys').where('user_id', '=', uid))) > 0)
    return true
  return accounts.some((account) => !excluded(account.provider_id) && usable.has(account.provider_id))
}

export function createExternalLogin(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  plugins: Pick<
    PluginSystem,
    'loginProviders' | 'loginAuthorize' | 'loginExchange' | 'hasLoginProvider' | 'translate' | 'get'
  >
  mail: Pick<MailService, 'configured'>
  jobs: Pick<JobRunner, 'enqueue'>
  register: (input: RegisterInput) => Promise<{ uid: number }>
  now: () => Date
}) {
  const { db, plugins, now } = options

  async function available(pluginId: string, providerId: string): Promise<LoginProviderEntry | null> {
    return (
      (await plugins.loginProviders()).find((item) => item.pluginId === pluginId && item.providerId === providerId) ??
      null
    )
  }

  async function putVerification(identifier: string, value: unknown, ttlSeconds: number) {
    const at = now()
    await db
      .insertInto('verifications')
      .values({
        identifier,
        value: JSON.stringify(value),
        expires_at: writeAuthDate(db, toIsoTimestamp(new Date(at.getTime() + ttlSeconds * 1000))),
        created_at: writeAuthDate(db, toIsoTimestamp(at)),
        updated_at: writeAuthDate(db, toIsoTimestamp(at)),
      })
      .execute()
  }

  async function readVerification<T>(identifier: string, schema: z.ZodType<T>): Promise<T | null> {
    const row = await db
      .selectFrom('verifications')
      .select(['value', 'expires_at'])
      .where('identifier', '=', identifier)
      .executeTakeFirst()
    if (!row || readAuthDate(row.expires_at) <= toIsoTimestamp(now())) return null
    try {
      const parsed = schema.safeParse(JSON.parse(row.value))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** 只用一次：两个请求同时拿着同一个 state 回来，只有删到那一行的那个继续 */
  async function consumeState(state: string): Promise<StateRecord | null> {
    const identifier = stateKey(state)
    const record = await readVerification(identifier, stateSchema)
    const result = await db.deleteFrom('verifications').where('identifier', '=', identifier).executeTakeFirst()
    return record && Number(result.numDeletedRows) > 0 ? record : null
  }

  /** 配置了邮件时给账号邮箱发绑定通知，第三方的名称按收件人的语言翻译。发不出去不影响绑定 */
  async function notifyLinked(uid: number, pluginId: string, label: string) {
    try {
      if (!(await options.mail.configured())) return
      const [user, values] = await Promise.all([
        db.selectFrom('users').select(['email', 'locale']).where('id', '=', uid).executeTakeFirst(),
        options.settings.read(['site.locale']),
      ])
      if (!user) return
      const locale = (user.locale ? matchLocale(user.locale) : null) ?? values['site.locale']
      await options.jobs.enqueue(db, MAIL_JOB, {
        template: 'externalAccountLinked',
        uid,
        to: user.email,
        provider: plugins.translate(pluginId, label, locale),
      })
    } catch {
      // 不记录可能带着邮箱的异常
      console.warn('[mail] external_linked_enqueue_failed')
    }
  }

  /**
   * 把身份绑到 uid 上。先锁用户的行：同一用户的绑定和解绑排队执行。
   * - stranded：首次登录直接绑定没有登录方式的账号时，锁住之后再确认一遍它还是没有（usable 是能用的第三方）。
   *   两家第三方同时声明同一个邮箱时，只有先到的那个能绑上
   * - sessionId：用户在安全页上发起的绑定，锁住之后确认发起绑定的会话还在（ADR-0036）。回调在开头确认过会话，
   *   之后要等第三方的网络请求；后台收回账号、退出全部登录在同一把锁下删会话，恰好在这中间提交的话，
   *   盗号的人就能把第三方账号绑回来
   */
  async function link(
    uid: number,
    providerId: string,
    subject: string,
    check: { stranded: { usable: ReadonlySet<string> } } | { sessionId: number },
  ): Promise<void> {
    const at = toIsoTimestamp(now())
    const timestamp = writeAuthDate(db, at)
    await transactionWithRetry(db, async (tx) => {
      await lockUser(tx, uid)
      if ('stranded' in check && (await hasLoginMethod(tx, uid, check.stranded.usable)))
        throw new DomainError('external_email_taken')
      if (
        'sessionId' in check &&
        !(await tx
          .selectFrom('sessions')
          .select('id')
          .where('id', '=', check.sessionId)
          .where('user_id', '=', uid)
          .where('expires_at', '>', writeAuthDate(tx, at))
          .executeTakeFirst())
      )
        throw new DomainError('external_login_expired')
      const existing = await tx
        .selectFrom('accounts')
        .select('user_id')
        .where('provider_id', '=', providerId)
        .where('account_id', '=', subject)
        .executeTakeFirst()
      if (existing) throw new DomainError(existing.user_id === uid ? 'already_bound' : 'identity_bound_elsewhere')
      const own = await tx
        .selectFrom('accounts')
        .select('id')
        .where('user_id', '=', uid)
        .where('provider_id', '=', providerId)
        .executeTakeFirst()
      if (own) throw new DomainError('already_bound')
      // 和别的用户同时绑同一个身份时由唯一索引兜底；insertOrIgnore 在 PG 上不会让事务作废
      const inserted = await insertOrIgnore(
        tx,
        'accounts',
        {
          user_id: uid,
          provider_id: providerId,
          account_id: subject,
          password: null,
          access_token: null,
          refresh_token: null,
          id_token: null,
          access_token_expires_at: null,
          refresh_token_expires_at: null,
          scope: null,
          created_at: timestamp,
          updated_at: timestamp,
        },
        ['provider_id', 'account_id'],
      )
      if (!inserted) throw new DomainError('identity_bound_elsewhere')
    })
  }

  /** 还没有绑定的身份第一次登录（ADR-0034"首次登录"） */
  async function firstSignIn(
    entry: LoginProviderEntry,
    identity: ExternalIdentity,
    next: string,
  ): Promise<ExternalCallbackResult> {
    const providerId = bindingProviderId(entry.pluginId, entry.providerId)
    const email = normalizeEmail(identity.email)
    if (email !== null) {
      const owner = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
      if (owner) {
        // 账号已经没有任何登录方式时，第三方确认过的邮箱和收到找回密码邮件是同一个证据；否则一律不绑定
        const usable = await usableBindings(plugins)
        if (!identity.emailVerified || (await hasLoginMethod(db, owner.id, usable)))
          throw new DomainError('external_email_taken')
        await link(owner.id, providerId, identity.subject, { stranded: { usable } })
        await notifyLinked(owner.id, entry.pluginId, entry.label)
        return { kind: 'signedIn', uid: owner.id, next }
      }
    }
    const values = await options.settings.read(['auth.registration.enabled'])
    if (!values['auth.registration.enabled']) throw new DomainError('registration_disabled')
    const pendingToken = random(32)
    await putVerification(
      pendingKey(pendingToken),
      {
        pluginId: entry.pluginId,
        providerId: entry.providerId,
        subject: identity.subject,
        email,
        emailVerified: identity.emailVerified,
        displayName: identity.displayName,
        next,
      } satisfies PendingRecord,
      EXTERNAL_PENDING_TTL_SECONDS,
    )
    return { kind: 'register', pendingToken, next }
  }

  return {
    /** 登录页上的按钮 */
    providers: () => plugins.loginProviders(),

    /**
     * 发起：生成 state 和 PKCE，向插件要授权地址。state 由调用方写进 Cookie。
     * 绑定（intent 为 link）时调用方已经确认会话是刚登录的；uid、sessionId 是当前会话的用户和会话
     */
    async start(input: {
      pluginId: string
      providerId: string
      intent: ExternalLoginIntent
      uid: number | null
      sessionId: number | null
      next: string
      siteUrl: string
      locale?: string
    }): Promise<{ url: string; state: string }> {
      // 插件没有启用、设置没有通过校验、Provider 不存在（ADR-0034"发起和回调"）
      if (!(await available(input.pluginId, input.providerId))) throw new DomainError('external_login_not_found')
      if (input.intent === 'link' && (input.uid === null || input.sessionId === null))
        throw new DomainError('unauthenticated')
      const state = random(32)
      const codeVerifier = random(64)
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
      await putVerification(
        stateKey(state),
        {
          pluginId: input.pluginId,
          providerId: input.providerId,
          intent: input.intent,
          uid: input.intent === 'link' ? input.uid : null,
          sessionId: input.intent === 'link' ? input.sessionId : null,
          next: input.next,
          codeVerifier,
        } satisfies StateRecord,
        EXTERNAL_STATE_TTL_SECONDS,
      )
      const url = await plugins.loginAuthorize(input.pluginId, input.providerId, {
        state,
        codeChallenge,
        locale: input.locale,
        redirectUri: input.siteUrl + externalCallbackPath(input.pluginId, input.providerId),
      })
      return { url, state }
    },

    /**
     * 回调。`cookieState` 是发起时写进 Cookie 的 state，`sessionUid`、`sessionId` 是当前会话的用户和会话。
     * 出错时抛 DomainError，params 里的 intent 告诉调用方该跳回登录页还是安全页
     */
    async callback(input: {
      pluginId: string
      providerId: string
      query: Readonly<Record<string, string>>
      cookieState: string | null
      sessionUid: number | null
      sessionId: number | null
      siteUrl: string
      locale?: string
    }): Promise<ExternalCallbackResult> {
      const state = input.query.state
      if (!state || !input.cookieState || !sameSecret(state, input.cookieState))
        throw new DomainError('external_login_expired')
      const record = await consumeState(state)
      if (!record || record.pluginId !== input.pluginId || record.providerId !== input.providerId)
        throw new DomainError('external_login_expired')
      const fail = (code: string) => new DomainError(code, { intent: record.intent })
      // RFC 6749 §4.1.2.1：用户在第三方点了取消，或者第三方拒绝了这次授权
      if (input.query.error !== undefined) throw fail('external_login_cancelled')
      const entry = await available(record.pluginId, record.providerId)
      if (!entry) throw fail('external_login_unavailable')
      let identity: ExternalIdentity
      try {
        identity = await plugins.loginExchange(record.pluginId, record.providerId, {
          query: input.query,
          locale: input.locale,
          codeVerifier: record.codeVerifier,
          redirectUri: input.siteUrl + externalCallbackPath(record.pluginId, record.providerId),
        })
      } catch (error) {
        throw error instanceof DomainError ? fail(error.code) : error
      }
      const providerId = bindingProviderId(record.pluginId, record.providerId)
      try {
        if (record.intent === 'link') {
          // 发起绑定之后换了账号登录、或者退出了：不能绑到别人身上。同一个人重新登录过也不行：绑定认的是发起时
          // 检查过"刚登录过"的那个会话，它被后台作废（退出全部登录、收回账号）之后，这个 state 就跟着失效
          if (
            record.uid === null ||
            typeof record.sessionId !== 'number' ||
            input.sessionUid !== record.uid ||
            input.sessionId !== record.sessionId
          )
            throw new DomainError('external_login_expired')
          await link(record.uid, providerId, identity.subject, { sessionId: record.sessionId })
          await notifyLinked(record.uid, record.pluginId, entry.label)
          return { kind: 'linked', next: record.next }
        }
        const bound = await db
          .selectFrom('accounts')
          .select('user_id')
          .where('provider_id', '=', providerId)
          .where('account_id', '=', identity.subject)
          .executeTakeFirst()
        if (bound) return { kind: 'signedIn', uid: bound.user_id, next: record.next }
        return await firstSignIn(entry, identity, record.next)
      } catch (error) {
        throw error instanceof DomainError ? fail(error.code) : error
      }
    },

    /** "完成注册"页预填的内容；暂存的身份过期或不存在时为 null */
    async pending(token: string | null) {
      if (!token) return null
      const record = await readVerification(pendingKey(token), pendingSchema)
      if (!record) return null
      const known = plugins.get(record.pluginId)
      const provider = known?.manifest.providers.login.find((item) => item.id === record.providerId)
      return {
        pluginId: record.pluginId,
        providerId: record.providerId,
        /** 插件的文案键 */
        label: provider?.label ?? record.providerId,
        email: record.email,
        emailVerified: record.emailVerified,
        displayName: record.displayName,
        next: record.next,
      }
    },

    /**
     * "完成注册"：经过注册用例，同一个事务里写绑定，不写密码。注册失败（例如邀请码不对）时暂存的身份还在，改了再提交；
     * 成功后删掉它
     */
    async complete(
      token: string | null,
      input: Omit<RegisterInput, 'password' | 'external'>,
    ): Promise<{ uid: number; next: string }> {
      const record = token ? await readVerification(pendingKey(token), pendingSchema) : null
      if (!token || !record) throw new DomainError('external_login_expired')
      // 插件这期间被停用了：不能建一个用不了这个绑定登录的账号
      if (!(await available(record.pluginId, record.providerId))) throw new DomainError('external_login_unavailable')
      const email = input.email.trim().toLowerCase()
      const { uid } = await options.register({
        ...input,
        external: {
          providerId: bindingProviderId(record.pluginId, record.providerId),
          subject: record.subject,
          emailVerified: record.emailVerified && record.email !== null && email === record.email,
          claim: async (tx) =>
            Number(
              (await tx.deleteFrom('verifications').where('identifier', '=', pendingKey(token)).executeTakeFirst())
                .numDeletedRows,
            ) > 0,
        },
      })
      return { uid, next: record.next }
    },

    /**
     * 安全页上的"第三方账号"：能用的 Provider，和这个用户已有的绑定。插件停用了的绑定也列出来，可以解绑。
     * 文案键由页面按插件翻译
     */
    async accounts(uid: number) {
      const [entries, rows] = await Promise.all([
        plugins.loginProviders(),
        db
          .selectFrom('accounts')
          .select(['provider_id', 'created_at'])
          .where('user_id', '=', uid)
          .where('provider_id', 'like', 'plugin:%')
          .orderBy('id')
          .execute(),
      ])
      const bound = new Map(rows.map((row) => [row.provider_id, readAuthDate(row.created_at)]))
      const list = entries.map((entry) => ({
        pluginId: entry.pluginId,
        providerId: entry.providerId,
        label: entry.label,
        icon: entry.icon,
        available: true,
        linkedAt: bound.get(bindingProviderId(entry.pluginId, entry.providerId)) ?? null,
      }))
      for (const row of rows) {
        if (list.some((item) => bindingProviderId(item.pluginId, item.providerId) === row.provider_id)) continue
        const [, pluginId = '', providerId = ''] = row.provider_id.split(':')
        const provider = plugins.get(pluginId)?.manifest.providers.login.find((item) => item.id === providerId)
        list.push({
          pluginId,
          providerId,
          label: provider?.label ?? providerId,
          icon: provider?.icon ?? '',
          available: false,
          linkedAt: readAuthDate(row.created_at),
        })
      }
      return list
    },

    /**
     * 解绑。解绑之后要还有能用的登录方式，否则 last_login_method。先锁用户的行，两个解绑请求排队执行；
     * 删除通行密钥由 Better Auth 处理、不锁这一行，同时删掉最后一个通行密钥和最后一个绑定可能都成功，还能用找回密码
     */
    async unlink(uid: number, pluginId: string, providerId: string): Promise<void> {
      const key = bindingProviderId(pluginId, providerId)
      const usable = await usableBindings(plugins)
      await transactionWithRetry(db, async (tx) => {
        await lockUser(tx, uid)
        const row = await tx
          .selectFrom('accounts')
          .select('id')
          .where('user_id', '=', uid)
          .where('provider_id', '=', key)
          .executeTakeFirst()
        if (!row) throw new DomainError('external_account_not_found')
        if (!(await hasLoginMethod(tx, uid, usable, { excluded: (provider) => provider === key })))
          throw new DomainError('last_login_method')
        await tx.deleteFrom('accounts').where('id', '=', row.id).execute()
      })
    },

    /** 账号有没有密码：没有的要先设置密码，才能用启动器登录、改邮箱、删除账号、开关两步验证 */
    async hasPassword(uid: number): Promise<boolean> {
      const row = await db
        .selectFrom('accounts')
        .select('password')
        .where('user_id', '=', uid)
        .where('provider_id', '=', 'credential')
        .executeTakeFirst()
      return !!row?.password
    },

    /**
     * 卸载插件之后没有任何登录方式的用户数：卸载确认里列出（ADR-0034）。规则和 hasLoginMethod 相同，
     * 写成一条查询：绑定多的插件也不用逐个用户去查
     */
    async strandedByUninstall(pluginId: string): Promise<number> {
      const prefix = `plugin:${pluginId}:`
      const usable = [...(await usableBindings(plugins))].filter((provider) => !provider.startsWith(prefix))
      return countRows(
        db
          .selectFrom('users')
          .where(
            'users.id',
            'in',
            db.selectFrom('accounts').select('user_id').where('provider_id', 'like', `${prefix}%`),
          )
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('accounts as other')
                  .select('other.id')
                  .whereRef('other.user_id', '=', 'users.id')
                  .where((inner) =>
                    inner.or([
                      inner.and([
                        inner('other.provider_id', '=', 'credential'),
                        inner('other.password', 'is not', null),
                        inner('other.password', '!=', ''),
                      ]),
                      ...(usable.length ? [inner('other.provider_id', 'in', usable)] : []),
                    ]),
                  ),
              ),
            ),
          )
          .where((eb) =>
            eb.not(
              eb.exists(eb.selectFrom('passkeys').select('passkeys.id').whereRef('passkeys.user_id', '=', 'users.id')),
            ),
          ),
      )
    },
  }
}

export type ExternalLogin = ReturnType<typeof createExternalLogin>

/**
 * 卸载插件时，在同一个事务里删掉它名下还没用完的 state 和暂存身份：之后装上来的同 id 插件可能对接的是另一个第三方，
 * 旧第三方的 subject 不能落到新插件的名下（和删除绑定同一个理由，ADR-0034）
 */
export async function clearExternalLoginState(executor: Kysely<CoreDatabase>, pluginId: string): Promise<void> {
  const rows = await executor
    .selectFrom('verifications')
    .select(['identifier', 'value'])
    .where('identifier', 'like', 'external-login:%')
    .where('value', 'like', `%"pluginId":${JSON.stringify(pluginId)}%`)
    .execute()
  const identifiers = rows
    .filter((row) => {
      try {
        return (JSON.parse(row.value) as { pluginId?: unknown }).pluginId === pluginId
      } catch {
        return false
      }
    })
    .map((row) => row.identifier)
  if (identifiers.length) await executor.deleteFrom('verifications').where('identifier', 'in', identifiers).execute()
}
