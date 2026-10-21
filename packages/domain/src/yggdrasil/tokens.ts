import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  readAuthBoolean,
  readAuthDate,
  toIsoTimestamp,
  transactionWithRetry,
  type CoreDatabase,
  type IsoTimestamp,
  type UserRole,
} from '@nextskin/db'
import type { Kysely } from 'kysely'
import { sha256 } from '../auth/auth.ts'
import { JOIN_SCOPE, parsePlayerReference, readScopes } from '../oauth/scopes.ts'
import { normalizeNameLookup } from '../players/queries.ts'
import type { createSettingQueries } from '../settings/queries.ts'
import type { PluginPasswordVerifier } from '../auth/password.ts'
import type { IssueTokenInterceptor } from '../plugins/system.ts'
import { createCredentials, type CredentialsInput } from './credentials.ts'
import { forbidden, YggdrasilError } from './errors.ts'

export interface YggdrasilProfile {
  id: string
  name: string
}
export interface AuthResponse {
  accessToken: string
  clientToken: string
  availableProfiles: YggdrasilProfile[]
  selectedProfile?: YggdrasilProfile
  user?: { id: string; properties: [] }
}
export interface LauncherLogin {
  id: number
  createdAt: IsoTimestamp
  validUntil: IsoTimestamp
  expiresAt: IsoTimestamp
  player: { pid: number; name: string } | null
  status: 'valid' | 'refreshable'
}
export interface AuthenticateInput extends CredentialsInput {
  clientToken: string | null
  requestUser: boolean
  /** 未提供时按未知 IP 处理，保留核心内部调用的兼容性 */
  ip?: string | null
}
export interface RefreshInput {
  accessToken: string | null
  clientToken: string | null
  requestUser: boolean
  selectedProfile: unknown
  /** 未提供时按未知 IP 处理，保留核心内部调用的兼容性 */
  ip?: string | null
}
export interface ValidateInput {
  accessToken: string | null
  clientToken: string | null
}

/** BS 用邮箱计算用户 UUID；角色 UUID 仍然由 players 表保存。 */
export function userUuid(email: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(email)
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 0x50
  bytes[8] = (bytes[8]! & 63) | 0x80
  return bytes.toString('hex')
}

function profileGiven(value: unknown): boolean {
  if (!value || value === '0') return false
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function createTokens(options: {
  db: Kysely<CoreDatabase>
  settings: ReturnType<typeof createSettingQueries>
  secretKey: string
  now: () => Date
  passwordPlugins?: PluginPasswordVerifier
  interceptIssueToken?: IssueTokenInterceptor
}) {
  const { db, settings, now } = options
  const credentials = createCredentials(options)

  const invalidToken = (unauthorized: boolean, locale: string | null = null) =>
    unauthorized
      ? new YggdrasilError('UnauthorizedException', 'yggdrasil.errors.token_unauthorized', locale)
      : forbidden('token_invalid', locale)

  const findLauncherToken = (hash: string) =>
    db
      .selectFrom('yggdrasil_tokens as token')
      .innerJoin('users', 'users.id', 'token.user_id')
      .leftJoin('players', 'players.id', 'token.player_id')
      .selectAll('token')
      .select([
        'users.email',
        'users.locale',
        'users.role',
        'players.user_id as playerOwner',
        'players.uuid',
        'players.name',
      ])
      .where('token.access_token_hash', '=', hash)
      .executeTakeFirst()

  async function readToken(accessToken: string | null, valid: boolean, unauthorized = false) {
    if (accessToken === null) throw invalidToken(unauthorized)
    const row = await findLauncherToken(sha256(accessToken))
    const time = toIsoTimestamp(now())
    if (!row || row.expires_at <= time || (valid && row.valid_until <= time))
      throw invalidToken(unauthorized, row?.locale)
    return { ...row, kind: 'launcher' as const }
  }
  type Token = Awaited<ReturnType<typeof readToken>>

  async function readSessionToken(accessToken: string | null, unauthorized = false) {
    if (accessToken === null) throw invalidToken(unauthorized)
    const hash = sha256(accessToken)
    const launcher = await findLauncherToken(hash)
    const time = toIsoTimestamp(now())
    // 找到了启动器令牌就沿用原有的两段有效期，不能用同哈希的 OAuth 令牌绕过失效
    if (launcher) {
      if (launcher.expires_at <= time || launcher.valid_until <= time) throw invalidToken(unauthorized, launcher.locale)
      return { ...launcher, kind: 'launcher' as const }
    }
    const token = await db
      .selectFrom('oauth_access_tokens as token')
      .innerJoin('users', 'users.id', 'token.user_id')
      .innerJoin('oauth_clients as client', 'client.client_id', 'token.client_id')
      .selectAll('token')
      .select(['users.email', 'users.locale', 'users.role', 'client.disabled'])
      .where('token.token', '=', hash)
      .executeTakeFirst()
    if (
      !token ||
      token.token !== hash ||
      token.user_id === null ||
      token.revoked !== null ||
      readAuthDate(token.expires_at) <= time ||
      !readScopes(token.scopes).includes(JOIN_SCOPE) ||
      readAuthBoolean(token.disabled ?? false)
    )
      throw invalidToken(unauthorized, token?.locale)
    const pid = parsePlayerReference(token.reference_id)
    const player =
      pid === null
        ? null
        : await db
            .selectFrom('players')
            .select(['user_id as playerOwner', 'uuid', 'name'])
            .where('id', '=', pid)
            .executeTakeFirst()
    if (!player) throw invalidToken(unauthorized, token.locale)
    return { ...token, ...player, user_id: token.user_id, player_id: pid, kind: 'oauth' as const }
  }

  function assertOwned(token: Awaited<ReturnType<typeof readSessionToken>>, unauthorized = false) {
    if (token.player_id !== null && token.playerOwner !== token.user_id) {
      if (unauthorized)
        throw new YggdrasilError('UnauthorizedException', 'yggdrasil.errors.token_unauthorized', token.locale)
      throw forbidden('token_invalid', token.locale)
    }
  }
  function assertNotBanned(token: { role: string; locale: string | null }) {
    if (token.role === 'banned') throw forbidden('user_banned', token.locale)
  }
  function assertClient(token: Token, client: string | null) {
    if (client !== null && token.client_token !== client) throw forbidden('client_token_mismatch', token.locale)
  }
  const profiles = (connection: Kysely<CoreDatabase>, uid: number) =>
    connection
      .selectFrom('players')
      .select(['id as pid', 'uuid as id', 'name'])
      .where('user_id', '=', uid)
      .orderBy('players.id')
      .execute()

  /**
   * 签发事务的第一步，先于任何读取：锁住用户行，同一用户的签发依次进行，上限才不会被并发签发冲破。
   * 给了密码哈希时再锁住密码那一行，并确认它仍是刚才核对过的那个：改密码要等这个事务提交，
   * 提交后的吊销（core.ts 的 onPasswordChanged）一定能删掉这里签发的令牌；已经改了就不签发
   */
  async function lockOwner(tx: Kysely<CoreDatabase>, uid: number, passwordHash?: string): Promise<boolean> {
    // mysql2 默认启用 FOUND_ROWS，值没变的行也计入更新数
    const locked = await tx
      .updateTable('users')
      .set((eb) => ({ role: eb.ref('role') }))
      .where('id', '=', uid)
      .executeTakeFirstOrThrow()
    if (locked.numUpdatedRows !== 1n) return false
    if (passwordHash === undefined) return true
    const pinned = await tx
      .updateTable('accounts')
      .set((eb) => ({ password: eb.ref('password') }))
      .where('user_id', '=', uid)
      .where('provider_id', '=', 'credential')
      .where('password', '=', passwordHash)
      .executeTakeFirstOrThrow()
    return pinned.numUpdatedRows === 1n
  }

  /** 调用方要先在同一个事务里 lockOwner */
  async function issue(
    tx: Kysely<CoreDatabase>,
    user: { id: number; email: string },
    clientToken: string,
    playerId: number | null,
    requestUser: boolean,
    values: {
      'yggdrasil.tokenValidSeconds': number
      'yggdrasil.tokenRefreshableSeconds': number
      'yggdrasil.tokensPerUser': number
    },
  ): Promise<AuthResponse> {
    const time = now().getTime()
    const accessToken = randomBytes(32).toString('hex')
    const validMs = values['yggdrasil.tokenValidSeconds'] * 1000
    await tx
      .insertInto('yggdrasil_tokens')
      .values({
        access_token_hash: sha256(accessToken),
        client_token: clientToken,
        user_id: user.id,
        player_id: playerId,
        created_at: toIsoTimestamp(new Date(time)),
        valid_until: toIsoTimestamp(new Date(time + validMs)),
        expires_at: toIsoTimestamp(
          new Date(time + Math.max(validMs, values['yggdrasil.tokenRefreshableSeconds'] * 1000)),
        ),
      })
      .execute()
    // MySQL 不接受 IN 子查询里的 LIMIT；SQLite 与 MySQL 的 OFFSET 也必须配 LIMIT。
    const extra = await tx
      .selectFrom('yggdrasil_tokens')
      .select('id')
      .where('user_id', '=', user.id)
      .orderBy('id', 'desc')
      .limit(2147483647)
      .offset(values['yggdrasil.tokensPerUser'])
      .execute()
    if (extra.length)
      await tx
        .deleteFrom('yggdrasil_tokens')
        .where(
          'id',
          'in',
          extra.map((row) => row.id),
        )
        .execute()
    const available = await profiles(tx, user.id)
    const selected = available.find((player) => player.pid === playerId)
    return {
      accessToken,
      clientToken,
      availableProfiles: available.map(({ id, name }) => ({ id, name })),
      ...(selected ? { selectedProfile: { id: selected.id, name: selected.name } } : {}),
      ...(requestUser ? { user: { id: userUuid(user.email), properties: [] as [] } } : {}),
    }
  }
  const tokenSettings = () =>
    settings.read(['yggdrasil.tokenValidSeconds', 'yggdrasil.tokenRefreshableSeconds', 'yggdrasil.tokensPerUser'])
  const revokeAllTokens = async (uid: number): Promise<void> => {
    await db.deleteFrom('yggdrasil_tokens').where('user_id', '=', uid).execute()
  }

  async function checkIssuance(
    uid: number,
    user: { role: UserRole; locale: string | null },
    via: 'authenticate' | 'refresh',
    ip: string | null | undefined,
  ) {
    if (!options.interceptIssueToken) return
    const result = await options.interceptIssueToken(
      { uid, via },
      { actor: { kind: 'user', uid, role: user.role }, locale: user.locale, ip: ip ?? null },
    )
    if (result.action === 'deny')
      throw new YggdrasilError('ForbiddenOperationException', 'yggdrasil.errors.plugin_denied', user.locale, {
        message: result.message,
      })
    if (result.action === 'unavailable') throw forbidden('plugin_unavailable', user.locale)
  }

  const service = {
    async authenticate(input: AuthenticateInput): Promise<AuthResponse> {
      const { user, passwordHash } = await credentials(input)
      assertNotBanned(user)
      const verification = await settings.read(['auth.requireEmailVerification'])
      if (verification['auth.requireEmailVerification'] && !readAuthBoolean(user.email_verified))
        throw forbidden('email_not_verified', user.locale)
      // 列宽 255；PostgreSQL 的文本里不能有 NUL
      if (input.clientToken !== null && (input.clientToken.length > 255 || input.clientToken.includes('\0')))
        throw new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.client_token_invalid', user.locale)
      await checkIssuance(user.id, user, 'authenticate', input.ip)
      const values = await tokenSettings()
      return transactionWithRetry(db, async (tx) => {
        if (!(await lockOwner(tx, user.id, passwordHash))) throw forbidden('invalid_credentials')
        const available = await profiles(tx, user.id)
        return issue(
          tx,
          user,
          input.clientToken ?? randomUUID().replaceAll('-', ''),
          available.length === 1 ? available[0]!.pid : null,
          input.requestUser,
          values,
        )
      })
    },
    async refresh(input: RefreshInput): Promise<AuthResponse> {
      const token = await readToken(input.accessToken, false)
      assertClient(token, input.clientToken)
      assertNotBanned(token)
      assertOwned(token)
      let playerId = token.player_id
      /** 这次刷新新选的角色 */
      let selectedPid: number | null = null
      if (profileGiven(input.selectedProfile)) {
        const selected = input.selectedProfile
        const name =
          typeof selected === 'object' && selected !== null && 'name' in selected && typeof selected.name === 'string'
            ? normalizeNameLookup(selected.name)
            : null
        const named =
          name === null
            ? null
            : await db.selectFrom('players').select('name_key').where('name_key', '=', name).executeTakeFirst()
        if (!named || named.name_key !== name)
          throw new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.player_not_found', token.locale)
        if (playerId !== null)
          throw new YggdrasilError('IllegalArgumentException', 'yggdrasil.errors.profile_already_bound', token.locale)
        const id = typeof selected === 'object' && selected !== null && 'id' in selected ? selected.id : null
        const owned = (await profiles(db, token.user_id)).find((player) => player.id === id)
        if (!owned) throw forbidden('profile_not_owned', token.locale)
        playerId = selectedPid = owned.pid
      }
      await checkIssuance(token.user_id, token, 'refresh', input.ip)
      const values = await tokenSettings()
      return transactionWithRetry(db, async (tx) => {
        if (!(await lockOwner(tx, token.user_id))) throw forbidden('token_invalid', token.locale)
        // 新选的角色在事务外确认过属于令牌的用户，锁住用户之后再确认一次：后台转让锁着原主人，恰好在两者之间提交的话，
        // 不能再给原主人签发绑定这个角色的令牌（ADR-0036"转让"）。已经绑定的令牌不用：转让在同一个事务里删掉了它
        if (
          selectedPid !== null &&
          !(await tx
            .selectFrom('players')
            .select('id')
            .where('id', '=', selectedPid)
            .where('user_id', '=', token.user_id)
            .executeTakeFirst())
        )
          throw forbidden('profile_not_owned', token.locale)
        const removed = await tx
          .deleteFrom('yggdrasil_tokens')
          .where('id', '=', token.id)
          .where('access_token_hash', '=', token.access_token_hash)
          .executeTakeFirstOrThrow()
        if (removed.numDeletedRows !== 1n) throw forbidden('token_invalid', token.locale)
        return issue(
          tx,
          { id: token.user_id, email: token.email },
          token.client_token,
          playerId,
          input.requestUser,
          values,
        )
      })
    },
    async validate(input: ValidateInput): Promise<void> {
      const token = await readSessionToken(input.accessToken)
      if (token.kind === 'launcher') assertClient(token, input.clientToken)
      assertNotBanned(token)
      assertOwned(token)
    },
    async invalidate(input: { accessToken: string | null }): Promise<void> {
      if (input.accessToken === null) return
      const hash = sha256(input.accessToken)
      const removed = await db
        .deleteFrom('yggdrasil_tokens')
        .where('access_token_hash', '=', hash)
        .executeTakeFirstOrThrow()
      if (removed.numDeletedRows === 0n)
        await transactionWithRetry(db, async (tx) => {
          const token = await tx
            .selectFrom('oauth_access_tokens')
            .select(['id', 'token', 'refresh_id'])
            .where('token', '=', hash)
            .executeTakeFirst()
          // MySQL 的二进制排序规则仍忽略末尾空格，删行前必须逐字核对
          if (!token || token.token !== hash) return
          if (token.refresh_id !== null)
            await tx.deleteFrom('oauth_refresh_tokens').where('id', '=', token.refresh_id).execute()
          else await tx.deleteFrom('oauth_access_tokens').where('id', '=', token.id).execute()
        })
    },
    async signout(input: CredentialsInput): Promise<void> {
      const { user } = await credentials(input)
      await revokeAllTokens(user.id)
    },
    async listTokens(uid: number): Promise<LauncherLogin[]> {
      const time = toIsoTimestamp(now())
      const rows = await db
        .selectFrom('yggdrasil_tokens as token')
        .leftJoin('players', (join) =>
          join.onRef('players.id', '=', 'token.player_id').onRef('players.user_id', '=', 'token.user_id'),
        )
        .select([
          'token.id',
          'token.created_at',
          'token.valid_until',
          'token.expires_at',
          'token.player_id',
          'players.id as pid',
          'players.name',
        ])
        .where('token.user_id', '=', uid)
        .where('token.expires_at', '>', time)
        .orderBy('token.id', 'desc')
        .execute()
      return rows
        .filter((row) => row.player_id === null || row.pid !== null)
        .map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          validUntil: row.valid_until,
          expiresAt: row.expires_at,
          player: row.pid !== null && row.name !== null ? { pid: row.pid, name: row.name } : null,
          status: row.valid_until > time ? 'valid' : 'refreshable',
        }))
    },
    async revokeToken(uid: number, id: number): Promise<void> {
      await db.deleteFrom('yggdrasil_tokens').where('user_id', '=', uid).where('id', '=', id).execute()
    },
    revokeAllTokens,
  }
  return { service, readToken, readSessionToken, assertOwned, assertNotBanned }
}
export type Tokens = ReturnType<typeof createTokens>
