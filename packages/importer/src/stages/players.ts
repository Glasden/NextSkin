// players → players，以及每个角色的 UUID（docs/schema.md "UUID"）。写完一页就用协议端点的查询读回来比对（ADR-0031）
import { randomUUID } from 'node:crypto'
import { countRows, toNumber } from '@nextskin/db'
import { createPlayerQueries, offlineUuid, toNameKey } from '@nextskin/domain/importer'
import { sql } from 'kysely'
import {
  chunks,
  existingUsers,
  importedTextures,
  MAX_ID,
  pages,
  type PlayerUuid,
  type StageContext,
} from '../context.ts'
import {
  addBlocking,
  bump,
  pushCapped,
  UUID_LIST_LIMIT,
  type UuidCandidate,
  type UuidSource,
  type VerificationMismatch,
} from '../report.ts'
import { bsDateTime, toInt, toText } from '../values.ts'

/** 32 位十六进制，或者带连字符的标准写法（8-4-4-4-12），大小写都可以；统一成 32 位小写。其余写法不合法 */
export function normalizeUuid(value: string): string | null {
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)) return null
  return value.replaceAll('-', '').toLowerCase()
}

/** --uuid-overrides：{ "<pid>": "<uuid>" }，带不带连字符、大小写都可以 */
export function parseUuidOverrides(
  input: Readonly<Record<string, string>>,
  ctx: Pick<StageContext, 'report'>,
): Map<number, string> {
  const result = new Map<number, string>()
  for (const [pid, value] of Object.entries(input)) {
    const id = /^[1-9]\d*$/.test(pid) ? Number(pid) : null
    const uuid = typeof value === 'string' ? normalizeUuid(value.trim()) : null
    if (id === null || !Number.isSafeInteger(id) || uuid === null)
      addBlocking(ctx.report, { code: 'uuid_override_invalid', pid, value: String(value) })
    else result.set(id, uuid)
  }
  return result
}

interface Owner {
  pid: number
  name: string
  source: UuidSource
}

/** 生成的 UUID（离线算法或随机）还没有游戏服务器见过，冲突时让给映射表里的和指定的 */
const isGenerated = (source: UuidSource) => source === 'offline' || source === 'random'

export async function importPlayers(ctx: StageContext, overrides: ReadonlyMap<number, string>): Promise<void> {
  const { src, tx, report, schema } = ctx
  const stats = report.tables.players
  const uuidTable = schema.uuid
  stats.source = await countRows(src.selectFrom(schema.tables.players))
  const names = new Map<string, { pid: number; name: string }>()
  const duplicateNames = new Map<string, { pid: number; name: string }[]>()
  const owners = new Map<string, Owner>()
  const duplicateUuids = new Map<string, number[]>()
  const usedOverrides = new Set<number>()
  // 报告里生成的 UUID 列表；冲突时被换成随机 UUID 的角色要改它的条目
  const listed = new Map<number, { pid: number; name: string; uuid: string; source: UuidSource }>()
  const queries = createPlayerQueries(tx)

  // 这一页的角色写完之后再交给 onPlayerUuid：同一页里的冲突可能还会改掉前面角色的 UUID
  let pageUuids = new Map<number, PlayerUuid>()
  for await (const rows of pages(src, schema.tables.players, 'pid', [
    'pid',
    'uid',
    'name',
    'tid_skin',
    'tid_cape',
    'last_modified',
  ])) {
    const players = rows
      .map((row) => ({
        pid: toInt(row.pid)!,
        uid: toInt(row.uid) ?? 0,
        name: toText(row.name) ?? '',
        skin: toInt(row.tid_skin) ?? 0,
        cape: toInt(row.tid_cape) ?? 0,
        modified: row.last_modified,
      }))
      .filter((player) => player.pid <= MAX_ID)
    const pids = players.map((player) => player.pid)
    const candidates = await uuidCandidates(ctx, pids)
    const users = await existingUsers(
      tx,
      players.map((player) => player.uid),
    )
    const textures = await importedTextures(
      tx,
      players.flatMap((player) => [player.skin, player.cape]),
    )
    const values = []
    for (const player of players) {
      if (overrides.has(player.pid)) usedOverrides.add(player.pid)
      if (!users.has(player.uid)) {
        bump(stats.skipped, 'user_missing')
        continue
      }
      const nameKey = toNameKey(player.name)
      const sameName = names.get(nameKey)
      if (sameName) {
        const list = duplicateNames.get(nameKey) ?? [sameName]
        list.push({ pid: player.pid, name: player.name })
        duplicateNames.set(nameKey, list)
        bump(stats.skipped, 'duplicate_name')
        continue
      }
      names.set(nameKey, { pid: player.pid, name: player.name })

      const resolved = resolveUuid(ctx, player, candidates.get(player.pid) ?? [], overrides.get(player.pid))
      if (!resolved) {
        bump(stats.skipped, 'uuid_unresolved')
        continue
      }
      let { uuid, source } = resolved
      const owner = owners.get(uuid)
      if (owner) {
        if (isGenerated(source)) {
          // 离线算法算出的 UUID 已经被另一个角色占用，改用随机 UUID（ADR-0015）
          uuid = randomUUID().replaceAll('-', '')
          source = 'random'
        } else if (isGenerated(owner.source)) {
          await reassign(ctx, owner, owners, listed, values, pageUuids)
        } else {
          const list = duplicateUuids.get(uuid) ?? [owner.pid]
          list.push(player.pid)
          duplicateUuids.set(uuid, list)
          bump(stats.skipped, 'duplicate_uuid')
          continue
        }
      }
      owners.set(uuid, { pid: player.pid, name: player.name, source })
      pageUuids.set(player.pid, { pid: player.pid, name: player.name, uuid, source })
      report.uuid.counts[source]++
      if (source !== 'pid' && source !== 'name') {
        const entry = { pid: player.pid, name: player.name, uuid, source }
        pushCapped(report.uuid.generated, entry, UUID_LIST_LIMIT)
        if (report.uuid.generated.items.at(-1) === entry) listed.set(player.pid, entry)
      }

      const skin = player.skin > 0 ? textures.get(player.skin) : undefined
      const cape = player.cape > 0 ? textures.get(player.cape) : undefined
      if (player.skin > 0 && !skin) bump(stats.adjusted, 'skin_missing')
      if (player.cape > 0 && !cape) bump(stats.adjusted, 'cape_missing')
      let modified = bsDateTime(player.modified, ctx.timeZone)
      if (!modified) {
        modified = ctx.now
        bump(stats.adjusted, 'invalid_last_modified')
      }
      values.push({
        id: player.pid,
        user_id: player.uid,
        name: player.name,
        name_key: nameKey,
        uuid,
        skin_texture_id: skin ? player.skin : null,
        cape_texture_id: cape ? player.cape : null,
        created_at: modified,
        updated_at: modified,
        // BS 删除任何角色都按现价退还，迁移前后删除角色退还的积分不变（ADR-0022）
        score_paid: Math.max(0, Math.min(MAX_ID, ctx.rules.scorePerPlayer)),
      })
    }
    for (const part of chunks(values, 200)) await tx.insertInto('players').values(part).execute()
    stats.imported += values.length

    // 比对：按协议端点同一套查询读回来，与旧库的 UUID、皮肤和披风的 hash、模型比较
    const expected = await expectedTextures(ctx, values)
    for (const value of values) {
      const view = await queries.findByName(value.name)
      report.verification.checked++
      const skin = value.skin_texture_id ? expected.get(value.skin_texture_id) : undefined
      const cape = value.cape_texture_id ? expected.get(value.cape_texture_id) : undefined
      const compare = (field: VerificationMismatch['field'], wanted: string | null, actual: string | null) => {
        if (wanted !== actual)
          pushCapped(report.verification.mismatches, {
            pid: value.id,
            name: value.name,
            field,
            expected: wanted,
            actual,
          })
      }
      if (!view) {
        compare('found', 'found', null)
        continue
      }
      compare('pid', String(value.id), String(view.pid))
      compare('uuid', value.uuid, view.uuid)
      compare('skin', skin?.hash ?? null, view.skin?.hash ?? null)
      compare('model', skin?.type ?? null, view.skin?.type ?? null)
      compare('cape', cape?.hash ?? null, view.cape?.hash ?? null)
    }
    if (ctx.onPlayerUuid) for (const entry of pageUuids.values()) ctx.onPlayerUuid(entry)
    pageUuids = new Map()
    ctx.advance('players', rows.length)
  }

  for (const [nameKey, players] of duplicateNames)
    addBlocking(report, { code: 'duplicate_player_name', nameKey, players })
  for (const [uuid, pids] of duplicateUuids) addBlocking(report, { code: 'duplicate_uuid', uuid, pids })
  for (const pid of overrides.keys())
    if (!usedOverrides.has(pid)) addBlocking(report, { code: 'uuid_override_unknown_player', pid: String(pid) })
  if (uuidTable) report.uuid.orphanMappings = await orphanMappings(ctx)
}

/** 先占了 UUID 的角色是生成的：换成随机 UUID，把映射表里的值让给后来的角色 */
async function reassign(
  ctx: StageContext,
  owner: Owner,
  owners: Map<string, Owner>,
  listed: Map<number, { uuid: string; source: UuidSource }>,
  pending: { id: number; uuid: string }[],
  pageUuids: Map<number, PlayerUuid>,
): Promise<void> {
  const uuid = randomUUID().replaceAll('-', '')
  // 同一页里的角色还没写进库：改待写入的值，写完之后照常比对
  const unwritten = pending.find((value) => value.id === owner.pid)
  if (unwritten) unwritten.uuid = uuid
  else await ctx.tx.updateTable('players').set({ uuid }).where('id', '=', owner.pid).execute()
  ctx.report.uuid.counts[owner.source]--
  ctx.report.uuid.counts.random++
  owners.set(uuid, { ...owner, source: 'random' })
  const entry = listed.get(owner.pid)
  if (entry) {
    entry.uuid = uuid
    entry.source = 'random'
  }
  // 还没交给 onPlayerUuid 的改掉；已经交出去的（前面的页）再报告一次，以后一次为准
  const reported = pageUuids.get(owner.pid)
  if (reported) Object.assign(reported, { uuid, source: 'random' })
  else ctx.onPlayerUuid?.({ pid: owner.pid, name: owner.name, uuid, source: 'random' })
  if (unwritten) return
  // 换过之后再比对一次
  const view = await createPlayerQueries(ctx.tx).findByName(owner.name)
  if (view?.uuid !== uuid)
    pushCapped(ctx.report.verification.mismatches, {
      pid: owner.pid,
      name: owner.name,
      field: 'uuid',
      expected: uuid,
      actual: view?.uuid ?? null,
    })
}

/**
 * 两类候选值都查（schema.md "UUID" 第 1 条）：按 pid（表上有 pid 列时），以及在旧库里按名字关联，
 * 比较规则由旧库决定，与 yggdrasil-api 运行时的查找方式相同
 */
async function uuidCandidates(ctx: StageContext, pids: number[]): Promise<Map<number, UuidCandidate[]>> {
  const result = new Map<number, UuidCandidate[]>()
  const table = ctx.schema.uuid
  if (!table || !pids.length) return result
  const add = (pid: unknown, candidate: UuidCandidate) => {
    const id = toInt(pid)
    if (id === null) return
    const list = result.get(id) ?? []
    if (!list.some((item) => item.source === candidate.source && item.rowId === candidate.rowId)) list.push(candidate)
    result.set(id, list)
  }
  if (table.hasPid) {
    const rows = (await ctx.src
      .selectFrom(table.table)
      .select(['id', 'pid', 'name', 'uuid'] as never)
      .where('pid', 'in', pids)
      .orderBy('id')
      .execute()) as Record<string, unknown>[]
    for (const row of rows)
      add(row.pid, {
        source: 'pid',
        rowId: toInt(row.id) ?? 0,
        name: toText(row.name) ?? '',
        value: toText(row.uuid) ?? '',
      })
  }
  const joined = await sql<Record<string, unknown>>`select p.pid as pid, u.id as id, u.name as name, u.uuid as uuid
    from ${sql.table(ctx.schema.tables.players)} p inner join ${sql.table(table.table)} u on u.name = p.name
    where p.pid in (${sql.join(pids)}) order by u.id`.execute(ctx.src)
  for (const row of joined.rows)
    add(row.pid, {
      source: 'name',
      rowId: toInt(row.id) ?? 0,
      name: toText(row.name) ?? '',
      value: toText(row.uuid) ?? '',
    })
  return result
}

function resolveUuid(
  ctx: StageContext,
  player: { pid: number; name: string },
  candidates: UuidCandidate[],
  override: string | undefined,
): { uuid: string; source: UuidSource } | null {
  const report = ctx.report
  // 同一行可能既按 pid 又按名字被找到，只列一次
  const mismatched = new Set<number>()
  for (const candidate of candidates)
    if (candidate.name !== player.name && !mismatched.has(candidate.rowId)) {
      mismatched.add(candidate.rowId)
      pushCapped(report.uuid.nameMismatches, {
        pid: player.pid,
        name: player.name,
        mappingName: candidate.name,
        uuid: candidate.value,
      })
    }
  if (override) return { uuid: override, source: 'override' }
  if (!candidates.length)
    // 从来没有被 Yggdrasil 查询过，BS 还没给它分配；v3 与 BS 将来会分配的相同，v4 反正还没有游戏服务器见过
    return ctx.rules.uuidAlgorithm === 'offline'
      ? { uuid: offlineUuid(player.name), source: 'offline' }
      : { uuid: randomUUID().replaceAll('-', ''), source: 'random' }
  const values = new Set<string>()
  for (const candidate of candidates) {
    const normalized = normalizeUuid(candidate.value)
    if (normalized === null) {
      addBlocking(report, { code: 'uuid_invalid', pid: player.pid, name: player.name, candidate })
      return null
    }
    values.add(normalized)
  }
  if (values.size > 1) {
    addBlocking(report, { code: 'uuid_ambiguous', pid: player.pid, name: player.name, candidates })
    return null
  }
  return { uuid: [...values][0]!, source: candidates.some((candidate) => candidate.source === 'pid') ? 'pid' : 'name' }
}

/** 比对用的预期值：旧库里这些材质的 hash 和类型（只取导入了的） */
async function expectedTextures(
  ctx: StageContext,
  values: { skin_texture_id: number | null; cape_texture_id: number | null }[],
): Promise<Map<number, { hash: string; type: string }>> {
  const tids = [
    ...new Set(values.flatMap((value) => [value.skin_texture_id, value.cape_texture_id]).filter((tid) => tid !== null)),
  ]
  const result = new Map<number, { hash: string; type: string }>()
  for (const part of chunks(tids, 500)) {
    const rows = (await ctx.src
      .selectFrom(ctx.schema.tables.textures)
      .select(['tid', 'hash', 'type'] as never)
      .where('tid', 'in', part)
      .execute()) as Record<string, unknown>[]
    for (const row of rows) result.set(toInt(row.tid)!, { hash: toText(row.hash) ?? '', type: toText(row.type) ?? '' })
  }
  return result
}

/** 没有对应角色的映射行（改名或删除角色后留下的），不导入，只记数 */
async function orphanMappings(ctx: StageContext): Promise<number> {
  const table = ctx.schema.uuid!
  const players = sql.table(ctx.schema.tables.players)
  const byPid = table.hasPid
    ? sql`and (u.pid is null or not exists (select 1 from ${players} q where q.pid = u.pid))`
    : sql``
  const result = await sql<{ n: string | number | bigint }>`select count(*) as n from ${sql.table(table.table)} u
    where not exists (select 1 from ${players} p where p.name = u.name) ${byPid}`.execute(ctx.src)
  return toNumber(result.rows[0]!.n)
}
