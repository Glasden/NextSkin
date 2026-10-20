import {
  containsInsensitive,
  countRows,
  readAuthBoolean,
  toIsoTimestamp,
  transactionWithRetry,
  writeAuthDate,
  type CoreDatabase,
} from '@nextskin/db'
import { sql, type Kysely, type Transaction } from 'kysely'
import { can, outranks } from '../access/permissions.ts'
import { audit } from '../audit/write.ts'
import { DomainError } from '../errors.ts'
import { deleteOAuthClientRow, oauthClientView } from '../oauth/clients.ts'
import { SHARED_OAUTH_CLIENT_ID } from '../oauth/scopes.ts'
import { rejectNul } from '../text.ts'
import { authorize, lockTarget } from './context.ts'
import { notifyAccountChanged, readNoticeContext } from './notify.ts'
import { pagination } from './queries.ts'
import type { AdminOptions } from './service.ts'
import type { AdminActor, AdminOAuthClient } from './types.ts'

function clientRows(db: Kysely<CoreDatabase>) {
  return db.selectFrom('oauth_clients').selectAll()
}

export function createAdminOAuthClients(options: AdminOptions) {
  const { db, now, settings, mail, jobs } = options
  async function view(
    db: Kysely<CoreDatabase>,
    row: Awaited<ReturnType<typeof managed>>['row'],
  ): Promise<AdminOAuthClient> {
    const owner =
      row.user_id === null
        ? null
        : await db
            .selectFrom('users')
            .select(['id', 'nickname', 'role'])
            .where('id', '=', row.user_id)
            .executeTakeFirst()
    return {
      ...(await oauthClientView(db, row, toIsoTimestamp(now()))),
      shared: row.client_id === SHARED_OAUTH_CLIENT_ID,
      owner: owner ? { uid: owner.id, nickname: owner.nickname, role: owner.role } : null,
    }
  }
  async function managed(tx: Transaction<CoreDatabase>, actor: AdminActor, id: number) {
    const eventActor = await authorize(tx, actor, 'oauthClients.manage')
    const before = await tx.selectFrom('oauth_clients').select('user_id').where('id', '=', id).executeTakeFirst()
    if (!before) throw new DomainError('oauth_client_not_found')
    const owner = before.user_id === null ? null : await lockTarget(tx, before.user_id)
    // 无主人时没有用户锁可供串行；锁住应用行，多个超级管理员并发停用也只写一次审计。
    if (before.user_id === null)
      await tx
        .updateTable('oauth_clients')
        .set((eb) => ({ user_id: eb.ref('user_id') }))
        .where('id', '=', id)
        .where('user_id', 'is', null)
        .execute()
    const row = await clientRows(tx)
      .where('id', '=', id)
      .where('user_id', before.user_id === null ? 'is' : '=', before.user_id)
      .executeTakeFirst()
    if (!row || (before.user_id !== null && !owner)) throw new DomainError('oauth_client_not_found')
    if (!outranks(eventActor.role, owner?.role ?? 'admin'))
      throw new DomainError(owner ? 'user_not_manageable' : 'oauth_client_not_manageable')
    return { eventActor, owner, row }
  }
  async function setDisabled(actor: AdminActor, id: number, disabled: boolean): Promise<AdminOAuthClient> {
    const notice = await readNoticeContext(mail, settings)
    return transactionWithRetry(db, async (tx) => {
      const { eventActor, owner, row } = await managed(tx, actor, id)
      if (readAuthBoolean(row.disabled ?? false) === disabled) return view(tx, row)
      const at = toIsoTimestamp(now())
      await tx
        .updateTable('oauth_clients')
        .set({ disabled, updated_at: writeAuthDate(tx, at) })
        .where('id', '=', id)
        .execute()
      await audit(tx, {
        actor: eventActor,
        action: disabled ? 'oauthClient.disable' : 'oauthClient.enable',
        subject: { type: 'oauthClient', id },
        details: { clientId: row.client_id, name: row.name, ownerUid: owner?.id ?? null },
        ip: actor.ip,
        now: at,
      })
      if (disabled && owner)
        await notifyAccountChanged(tx, jobs, notice, {
          uid: owner.id,
          to: owner.email,
          at,
          changes: [{ kind: 'oauthClientDisabled', name: row.name || row.client_id }],
        })
      return view(tx, { ...row, disabled })
    })
  }
  return {
    async listOAuthClients(
      viewer: number,
      input: { q?: string; owner?: number; page: number; perPage?: number },
    ): Promise<{ total: number; items: AdminOAuthClient[]; owner?: { uid: number; nickname: string } | null }> {
      // 查询也按数据库里的身份检查，不能相信会话缓存。
      const self = await db.selectFrom('users').select('role').where('id', '=', viewer).executeTakeFirst()
      if (!self || !can(self.role, 'oauthClients.manage')) throw new DomainError('permission_denied')
      const q = rejectNul(input.q ?? '').trim()
      const filter = (query: ReturnType<typeof clientRows>) => {
        if (q)
          query = query.where((eb) =>
            eb.or([
              containsInsensitive('name', q),
              // MySQL 的 varchar 比较忽略末尾空格，额外核对长度才是逐字相等。
              eb.and([eb('client_id', '=', q), sql<boolean>`length(client_id) = length(${q})`]),
            ]),
          )
        if (input.owner !== undefined) query = query.where('user_id', '=', input.owner)
        return query
      }
      const { limit, offset } = pagination(input)
      const rows = await filter(clientRows(db))
        .orderBy((eb) =>
          eb
            .case()
            .when(
              sql<boolean>`client_id = ${SHARED_OAUTH_CLIENT_ID} and length(client_id) = ${SHARED_OAUTH_CLIENT_ID.length}`,
            )
            .then(0)
            .else(1)
            .end(),
        )
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute()
      const owner =
        input.owner === undefined
          ? undefined
          : ((await db
              .selectFrom('users')
              .select(['id', 'nickname'])
              .where('id', '=', input.owner)
              .executeTakeFirst()) ?? null)
      return {
        total: await countRows(filter(clientRows(db)).clearSelect()),
        items: await Promise.all(rows.map((row) => view(db, row))),
        ...(owner === undefined ? {} : { owner: owner && { uid: owner.id, nickname: owner.nickname } }),
      }
    },
    disableOAuthClient: (actor: AdminActor, id: number) => setDisabled(actor, id, true),
    enableOAuthClient: (actor: AdminActor, id: number) => setDisabled(actor, id, false),
    async deleteOAuthClient(actor: AdminActor, id: number): Promise<void> {
      const notice = await readNoticeContext(mail, settings)
      await transactionWithRetry(db, async (tx) => {
        const { eventActor, owner, row } = await managed(tx, actor, id)
        if (row.client_id === SHARED_OAUTH_CLIENT_ID) throw new DomainError('oauth_client_shared')
        const at = toIsoTimestamp(now())
        const client = await oauthClientView(tx, row, at)
        const time = writeAuthDate(tx, at)
        const counts = async (table: 'oauth_access_tokens' | 'oauth_refresh_tokens') =>
          countRows(
            tx
              .selectFrom(table)
              .where('client_id', '=', row.client_id)
              .where('revoked', 'is', null)
              .where('expires_at', '>', time),
          )
        const accessTokens = await counts('oauth_access_tokens')
        const refreshTokens = await counts('oauth_refresh_tokens')
        await deleteOAuthClientRow(tx, row)
        await audit(tx, {
          actor: eventActor,
          action: 'oauthClient.delete',
          subject: { type: 'oauthClient', id },
          details: {
            clientId: row.client_id,
            name: row.name,
            ownerUid: owner?.id ?? null,
            authorizedUsers: client.authorizedUsers,
            accessTokens,
            refreshTokens,
          },
          ip: actor.ip,
          now: at,
        })
        if (owner)
          await notifyAccountChanged(tx, jobs, notice, {
            uid: owner.id,
            to: owner.email,
            at,
            changes: [{ kind: 'oauthClientDeleted', name: row.name || row.client_id }],
          })
      })
    },
  }
}
