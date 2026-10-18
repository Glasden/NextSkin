// textures → textures、texture_files，并复制材质文件（docs/schema.md 的对照表和"运行"一节）
import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { countBy, countRows, toIsoTimestamp, type CoreDatabase, type IsoTimestamp } from '@nextskin/db'
import { DomainError, type ImagePool, type ImportableTextureStorage } from '@nextskin/domain/importer'
import type { Transaction } from 'kysely'
import { chunks, existingUsers, MAX_ID, PAGE_SIZE, pages, type StageContext } from '../context.ts'
import { bump, pushCapped } from '../report.ts'
import { bsDateTime, toFlag, toInt, toText } from '../values.ts'

const TYPES = new Set(['steve', 'alex', 'cape'])
/** 同时解码、复制的文件数。图像池默认最多 4 个线程，排队上限 64 */
const FILE_CONCURRENCY = 8
/** 每个缺失或解码不了的文件，报告里最多列出引用它的这么多个 tid */
const TIDS_PER_FILE = 20
/**
 * 记住这么多个失败的文件，同一个 hash 的后续材质不再读文件。超过之后再遇到的会重新检查，
 * 报告里失败文件的个数可能偏大；这样的站点内存不随失败文件的数量增长
 */
const FAILED_CACHE_LIMIT = 100_000

/**
 * 按上传的规则规范化之后的宽高（@nextskin/skin 的 normalizeTexture）：只有窄披风（22s×17s，补宽后不超过 1024）
 * 补宽成 64s×32s，其余保持原尺寸（不合规则的按原图）。重跑时用它判断上一次的像素 hash 是不是按同样的类型算的
 */
function normalizedSize(width: number, height: number, type: 'steve' | 'alex' | 'cape') {
  if (type === 'cape' && width % 22 === 0 && height === (width / 22) * 17 && (width / 22) * 64 <= 1024)
    return { width: (width / 22) * 64, height: (width / 22) * 32 }
  return { width, height }
}

/** PNG 头里的宽高（IHDR），不是 PNG 时返回 null */
async function pngSize(path: string): Promise<{ width: number; height: number } | null> {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(24)
    const { bytesRead } = await file.read(header, 0, 24, 0)
    if (bytesRead < 24 || header.readUInt32BE(0) !== 0x89504e47 || header.toString('latin1', 12, 16) !== 'IHDR')
      return null
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } finally {
    await file.close()
  }
}

export interface FileOptions {
  texturesDirectory: string
  storage: ImportableTextureStorage
  imagePool: ImagePool
  dryRun: boolean
  /** 这次运行的标识（UUID）：这次运行写入的 texture_files 行带着它，事务结束前清掉 */
  claim: string
}

interface ResolvedFile {
  hash: string
  pixelHash: string
  width: number
  height: number
  sizeBytes: number
  modifiedAt: IsoTimestamp
  existing: boolean
}

type Failure = 'missing' | 'undecodable'

/** 并发地处理 items，最多 limit 个同时进行 */
async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!)
    }),
  )
}

function createFileResolver(ctx: StageContext, options: FileOptions) {
  const files = ctx.report.files
  /** 缺失或解码不了的文件：同一个 hash 的后续材质直接跳过，不再读文件 */
  const failed = new Map<string, Failure>()
  /** 报告里列出的失败文件，后续引用它的 tid 追加进去 */
  const listed = new Map<string, { hash: string; tids: number[] }>()

  function fail(hash: string, reason: Failure, tid: number) {
    const entry = listed.get(hash)
    if (failed.has(hash)) {
      if (entry && entry.tids.length < TIDS_PER_FILE) entry.tids.push(tid)
      return
    }
    if (failed.size < FAILED_CACHE_LIMIT) failed.set(hash, reason)
    const created = { hash, tids: [tid] }
    pushCapped(files[reason], created)
    if (files[reason].items.at(-1) === created) listed.set(hash, created)
  }

  async function inspect(
    hash: string,
    type: 'steve' | 'alex' | 'cape',
    previous:
      | {
          pixel_hash: string | null
          width: number | null
          height: number | null
          size_bytes: number | null
          status: string
        }
      | undefined,
  ): Promise<ResolvedFile | Failure> {
    const path = join(options.texturesDirectory, hash)
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
        return 'missing'
      throw error
    }
    if (!info.isFile()) return 'missing'
    let bytes: Uint8Array | null = null
    let image: { pixelHash: string; width: number; height: number }
    // 重跑：上一次导入的行同一 hash、同样大小，沿用它的像素 hash 和宽高，不再解码。
    // tid 最小的材质换了类型（例如披风和皮肤共用一个窄披风文件，删掉了其中一条）时，规范化的结果不同，要重新解码
    const header = previous?.status === 'active' && previous.size_bytes === info.size ? await pngSize(path) : null
    const expected = header ? normalizedSize(header.width, header.height, type) : null
    if (expected && previous?.pixel_hash && previous.width === expected.width && previous.height === expected.height) {
      image = { pixelHash: previous.pixel_hash, width: previous.width, height: previous.height }
      files.reused++
    } else {
      bytes = await readFile(path)
      try {
        // 像素 hash 按 tid 最小的那条材质的类型规范化；图像池会转移字节的所有权，给它一份副本
        const inspected = await options.imagePool.inspect({ bytes: new Uint8Array(bytes), type })
        if (!inspected.conforming)
          pushCapped(files.nonconforming, { hash, type, width: inspected.width, height: inspected.height })
        image = inspected
      } catch (error) {
        if (error instanceof DomainError && error.code === 'texture_file_invalid') return 'undecodable'
        throw error
      }
      files.decoded++
    }
    if (!options.dryRun) {
      // 按原字节复制，不重新编码（不变量 3）；存储里已经有、大小相同的不再复制
      const stored = await options.storage.stat(hash)
      if (stored?.sizeBytes === info.size) files.alreadyStored++
      else {
        await options.storage.write(hash, options.claim, bytes ?? (await readFile(path)))
        files.copied++
      }
    }
    return {
      hash,
      ...image,
      sizeBytes: info.size,
      modifiedAt: toIsoTimestamp(new Date(Math.floor(info.mtimeMs))),
      existing: previous !== undefined,
    }
  }

  /** 返回这一页里每个 hash 能不能导入（文件在、能解码），并写好能导入的 texture_files 行 */
  return async function resolve(
    tx: Transaction<CoreDatabase>,
    entries: readonly { tid: number; hash: string; type: 'steve' | 'alex' | 'cape' }[],
  ): Promise<Map<string, 'ok' | Failure>> {
    const status = new Map<string, 'ok' | Failure>()
    // 按 tid 升序，第一次出现的就是 tid 最小的那条
    const firsts = new Map<string, (typeof entries)[number]>()
    for (const entry of entries) {
      const known = failed.get(entry.hash)
      if (known) {
        fail(entry.hash, known, entry.tid)
        status.set(entry.hash, known)
      } else if (!firsts.has(entry.hash)) firsts.set(entry.hash, entry)
    }
    const hashes = [...firsts.keys()]
    const rows = hashes.length
      ? await tx
          .selectFrom('texture_files')
          .select(['hash', 'pixel_hash', 'width', 'height', 'size_bytes', 'status', 'claim_id'])
          .where('hash', 'in', hashes)
          .execute()
      : []
    const previous = new Map(rows.filter((row) => firsts.has(row.hash)).map((row) => [row.hash, row]))
    const pending = hashes.filter((hash) => {
      if (previous.get(hash)?.claim_id !== options.claim) return true
      status.set(hash, 'ok')
      return false
    })
    const resolved: ResolvedFile[] = []
    await eachLimited(pending, FILE_CONCURRENCY, async (hash) => {
      const result = await inspect(hash, firsts.get(hash)!.type, previous.get(hash))
      if (typeof result === 'string') {
        fail(hash, result, firsts.get(hash)!.tid)
        status.set(hash, result)
      } else resolved.push(result)
    })
    // 写 texture_files：同一事务里只有一条连接，按顺序执行
    for (const file of resolved) {
      const values = {
        pixel_hash: file.pixelHash,
        width: file.width,
        height: file.height,
        size_bytes: file.sizeBytes,
        ref_count: 0,
        status: 'active' as const,
        claim_id: options.claim,
        status_changed_at: ctx.now,
        delete_attempted_at: null,
        delete_confirmed_at: null,
        // `/textures/{hash}` 的 Last-Modified：BS 用的是文件的修改时间
        created_at: file.modifiedAt,
      }
      if (file.existing) await tx.updateTable('texture_files').set(values).where('hash', '=', file.hash).execute()
      else
        await tx
          .insertInto('texture_files')
          .values({ hash: file.hash, ...values })
          .execute()
      status.set(file.hash, 'ok')
      files.total++
    }
    // 这一页里才发现失败的文件，同一页里引用它的其余材质也记进报告（以前就失败的，上面已经记过）
    for (const entry of entries) {
      const result = status.get(entry.hash)
      const first = firsts.get(entry.hash)
      if (result !== 'ok' && result !== undefined && first !== undefined && first !== entry)
        fail(entry.hash, result, entry.tid)
    }
    return status
  }
}

/** BS 的 size 是 KB。迁移那一刻删除材质能退多少，迁移之后仍然是多少（ADR-0025） */
function storageFee(ctx: StageContext, sizeKb: number, isPublic: boolean): number {
  const rules = ctx.rules
  let fee = sizeKb * (isPublic ? rules.scorePerKbPublic : rules.scorePerKbPrivate)
  if (isPublic && rules.takeBackScoresAfterDeletion) fee -= rules.scoreAwardPerTexture
  return Math.max(0, Math.min(MAX_ID, fee))
}

export async function importTextures(ctx: StageContext, options: FileOptions): Promise<void> {
  const { src, tx, report, schema } = ctx
  const stats = report.tables.textures
  stats.source = await countRows(src.selectFrom(schema.tables.textures))
  ctx.advance('textures', 0, undefined, stats.source)
  const resolve = createFileResolver(ctx, options)
  for await (const rows of pages(src, schema.tables.textures, 'tid', [
    'tid',
    'name',
    'type',
    'hash',
    'size',
    'uploader',
    'public',
    'upload_at',
    'likes',
  ])) {
    const candidates: { tid: number; hash: string; type: 'steve' | 'alex' | 'cape'; row: Record<string, unknown> }[] =
      []
    for (const row of rows) {
      const tid = toInt(row.tid)!
      if (tid > MAX_ID) continue
      const type = toText(row.type)
      const hash = toText(row.hash)
      if (!type || !TYPES.has(type)) bump(stats.skipped, 'invalid_type')
      else if (!hash || !/^[0-9a-f]{64}$/.test(hash)) bump(stats.skipped, 'invalid_hash')
      else candidates.push({ tid, hash, type: type as 'steve' | 'alex' | 'cape', row })
    }
    const status = await resolve(tx, candidates)
    const imported = candidates.filter((candidate) => status.get(candidate.hash) === 'ok')
    for (const candidate of candidates) {
      const result = status.get(candidate.hash)
      if (result !== 'ok') bump(stats.skipped, result === 'missing' ? 'file_missing' : 'file_undecodable')
    }
    const uploaders = await existingUsers(
      tx,
      imported.map((candidate) => toInt(candidate.row.uploader) ?? 0),
    )
    const descriptions = await readDescriptions(
      ctx,
      imported.map((candidate) => candidate.tid),
    )
    const values = imported.map(({ tid, hash, type, row }) => {
      const uploader = toInt(row.uploader) ?? 0
      if (!uploaders.has(uploader)) bump(stats.adjusted, 'uploader_missing')
      const isPublic = toFlag(row.public)
      let uploadedAt = bsDateTime(row.upload_at, ctx.timeZone)
      if (!uploadedAt) {
        uploadedAt = ctx.now
        bump(stats.adjusted, 'invalid_upload_at')
      }
      return {
        id: tid,
        hash,
        name: (toText(row.name) ?? '').slice(0, 128),
        type,
        description: descriptions.get(tid) ?? null,
        uploader_id: uploaders.has(uploader) ? uploader : null,
        is_public: isPublic ? (1 as const) : (0 as const),
        // 先存旧库的收藏数，导入衣柜之后与重新统计的结果比对（recountLikes）
        likes: Math.max(0, Math.min(MAX_ID, toInt(row.likes) ?? 0)),
        score_paid: storageFee(ctx, Math.max(0, toInt(row.size) ?? 0), isPublic),
        created_at: uploadedAt,
        updated_at: uploadedAt,
      }
    })
    for (const part of chunks(values, 200)) await tx.insertInto('textures').values(part).execute()
    const references = new Map<string, number>()
    for (const { hash } of imported) references.set(hash, (references.get(hash) ?? 0) + 1)
    for (const [hash, count] of references)
      await tx
        .updateTable('texture_files')
        .set((eb) => ({ ref_count: eb('ref_count', '+', count) }))
        .where('hash', '=', hash)
        .execute()
    stats.imported += values.length
    ctx.advance(
      'textures',
      rows.length,
      report.files.total + report.files.missing.total + report.files.undecodable.total,
    )
  }
}

async function readDescriptions(ctx: StageContext, tids: number[]): Promise<Map<number, string>> {
  const table = ctx.schema.descriptions
  const result = new Map<number, string>()
  if (!table || !tids.length) return result
  const rows = (await ctx.src
    .selectFrom(table.table)
    .select(['tid', table.column] as never)
    .where('tid', 'in', tids)
    .execute()) as Record<string, unknown>[]
  for (const row of rows) {
    const tid = toInt(row.tid)
    const text = toText(row[table.column])?.trim()
    if (tid !== null && text) result.set(tid, text)
  }
  return result
}

/**
 * 这次运行没有用到的 texture_files 行（上一次导入或新站留下的）删掉，用到的行清掉运行标识。
 * 删掉的行在存储里的文件由 core:texture-sweep 回收
 */
export async function finishTextureFiles(tx: Transaction<CoreDatabase>, claim: string): Promise<void> {
  await tx
    .deleteFrom('texture_files')
    .where((eb) => eb.or([eb('claim_id', 'is', null), eb('claim_id', '!=', claim)]))
    .execute()
  await tx.updateTable('texture_files').set({ claim_id: null }).where('claim_id', '=', claim).execute()
}

/** 收藏数按导入后的衣柜重新统计；与旧库不同的列进报告。BS 的计数是先读再写回，可能有偏差 */
export async function recountLikes(ctx: StageContext): Promise<void> {
  const { tx, report } = ctx
  let last = 0
  for (;;) {
    const rows = await tx
      .selectFrom('textures')
      .select(['id', 'likes'])
      .where('id', '>', last)
      .orderBy('id')
      .limit(PAGE_SIZE)
      .execute()
    if (!rows.length) break
    // 按材质分组计数：热门材质被很多人收藏时，也不把衣柜的行读进内存
    const counts = await countBy(
      tx.selectFrom('closet_items').where(
        'texture_id',
        'in',
        rows.map((row) => row.id),
      ),
      'texture_id',
    )
    for (const row of rows) {
      const actual = counts.get(row.id) ?? 0
      if (actual === row.likes) continue
      pushCapped(report.likes, { tid: row.id, before: row.likes, after: actual })
      await tx.updateTable('textures').set({ likes: actual }).where('id', '=', row.id).execute()
    }
    last = rows.at(-1)!.id
  }
}
