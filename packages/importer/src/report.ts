// 对账报告（ADR-0031）：结构化的数据，存进 import_runs.report，网页直接渲染；命令行和网页的下载按同一份数据生成 Markdown。
import type { SourceDescription } from './source/connection.ts'

/** 报告里的列表只留前 LIST_LIMIT 项，total 是总数。UUID 的来源列表放宽到 UUID_LIST_LIMIT */
export const LIST_LIMIT = 200
export const UUID_LIST_LIMIT = 5000

export interface CappedList<T> {
  items: T[]
  total: number
}

export function cappedList<T>(): CappedList<T> {
  return { items: [], total: 0 }
}

export function pushCapped<T>(list: CappedList<T>, item: T, limit = LIST_LIMIT): void {
  list.total++
  if (list.items.length < limit) list.items.push(item)
}

export function addBlocking(report: ImportReport, issue: BlockingIssue): void {
  pushCapped(report.blocking, issue)
}

/** 按 pid 找到的映射行，或者按名字关联上的映射行 */
export interface UuidCandidate {
  source: 'pid' | 'name'
  /** uuid 表的 id 列 */
  rowId: number
  /** 映射行里存的名字 */
  name: string
  value: string
}

/** 停止类问题：有任何一条，目标库不做任何改动。每条都要能在旧站处理（或者用 --uuid-overrides 指定） */
export type BlockingIssue =
  | {
      code: 'target_not_empty'
      /** replace：有上一次导入的数据；force：上一次导入之后新站产生了数据，或者有数据却从没导入过 */
      needs: 'replace' | 'force'
      current: TargetCounts
      newData: NewSiteData | null
    }
  | { code: 'id_out_of_range'; table: string; maxId: number }
  | { code: 'duplicate_email'; email: string; uids: number[] }
  | { code: 'duplicate_player_name'; nameKey: string; players: { pid: number; name: string }[] }
  | { code: 'duplicate_uuid'; uuid: string; pids: number[] }
  | { code: 'uuid_ambiguous'; pid: number; name: string; candidates: UuidCandidate[] }
  | { code: 'uuid_invalid'; pid: number; name: string; candidate: UuidCandidate }
  | { code: 'uuid_override_invalid'; pid: string; value: string }
  | { code: 'uuid_override_unknown_player'; pid: string }
  | { code: 'password_method_required'; uids: number[]; total: number }
  | { code: 'regex_unsupported'; option: string; value: string }
  | { code: 'text_too_long'; option: string; length: number }
  | { code: 'verification_failed'; mismatches: number }

export interface TargetCounts {
  users: number
  players: number
  textures: number
}

/** 上一次导入之后新站产生的数据；从没导入过时，就是目标库里现有的全部 */
export interface NewSiteData {
  sessions: number
  /** OAuth 的访问令牌、刷新令牌和授权记录 */
  oauthTokens: number
  launcherTokens: number
  /** 不是"导入"的积分流水：签到、上传、加入衣柜…… */
  scoreTransactions: number
  users: number
  /** 新建的，或者导入之后改过的（改名、换材质） */
  players: number
  textures: number
  closetItems: number
  /** 新的举报，或者导入之后处理过的 */
  reports: number
  oauthClients: number
  auditLogs: number
  /** 找回密码、两步验证、通行密钥、设备码、不是定时触发的后台任务 */
  other: number
}

/**
 * 这次导入写进去的范围，提交时记下：以后判断"导入之后新站产生的数据"按它比较，不按导入的行自带的时间
 * （旧站的时间可能在未来）。新站以后建的行 id 都更大：导入后同步过自增
 */
export interface ImportWatermark {
  maxUserId: number
  maxPlayerId: number
  maxTextureId: number
  maxReportId: number
  maxOAuthClientId: number
  /** 导入的行里最晚的 updated_at；导入之后改过的行晚于它和导入完成的时间 */
  playersUpdatedAt: string | null
  texturesUpdatedAt: string | null
}

export interface TableStats {
  /** 旧库的行数 */
  source: number
  imported: number
  /** 跳过的行数，按原因 */
  skipped: Record<string, number>
  /** 导入了、但某些引用被置空或值被调整的行数，按原因 */
  adjusted: Record<string, number>
}

export function tableStats(): TableStats {
  return { source: 0, imported: 0, skipped: {}, adjusted: {} }
}

export function bump(counts: Record<string, number>, reason: string, by = 1): void {
  counts[reason] = (counts[reason] ?? 0) + by
}

export type UuidSource = 'pid' | 'name' | 'override' | 'offline' | 'random'

export interface VerificationMismatch {
  pid: number
  name: string
  field: 'found' | 'pid' | 'uuid' | 'skin' | 'model' | 'cape'
  expected: string | null
  actual: string | null
}

export interface ImportReport {
  version: 1
  dryRun: boolean
  startedAt: string
  finishedAt: string
  /** 运行失败或被取消时的原因；数据库的错误已经由 packages/db 脱敏 */
  error: string | null
  source: SourceDescription & {
    prefix: string
    texturesDirectory: string
    timeZone: string
    passwordMethod: string
    /** BS 的 options 表里的 version */
    bsVersion: string | null
    /** uuid 表的结构：yggdrasil-api（只有 name）、yggdrasil-connect（有 pid 列），或者没有这张表 */
    uuidTable: 'none' | 'yggdrasil-api' | 'yggdrasil-connect'
  }
  blocking: CappedList<BlockingIssue>
  uuid: {
    counts: Record<UuidSource, number>
    /** 不是从映射表原样取来的：指定的、离线算法和随机生成的 */
    generated: CappedList<{ pid: number; name: string; uuid: string; source: UuidSource }>
    /** 映射行里的名字与角色名不完全相同（例如只差大小写），仍然用表里的值 */
    nameMismatches: CappedList<{ pid: number; name: string; mappingName: string; uuid: string }>
    /** 没有对应角色的映射行（改名或删除角色后留下的），不导入 */
    orphanMappings: number
  }
  tables: {
    users: TableStats
    players: TableStats
    textures: TableStats
    closet: TableStats
    reports: TableStats
    oauthClients: TableStats
  }
  files: {
    /** 导入的不同文件数 */
    total: number
    /** 解码算了像素 hash 的 */
    decoded: number
    /** 沿用目标库上一次导入的像素 hash 和宽高的 */
    reused: number
    /** 复制进材质存储的；存储里已经有、大小相同的不再复制（试跑不复制） */
    copied: number
    alreadyStored: number
    missing: CappedList<{ hash: string; tids: number[] }>
    undecodable: CappedList<{ hash: string; tids: number[] }>
    /** 能解码、尺寸不合 NextSkin 规则的，照样导入 */
    nonconforming: CappedList<{ hash: string; type: string; width: number; height: number }>
  }
  settings: {
    imported: string[]
    /** 超出范围、取了边界值的 */
    clamped: { key: string; from: string; to: string }[]
    /** 值不合法、没有导入的 */
    invalid: { option: string; value: string }[]
    /** 不导入、但旧站改过的设置 */
    notImported: { option: string; value: string }[]
    /** 公告和内容政策的其他语言版本，没有导入 */
    otherLocales: string[]
    /** 含原始 HTML 的公告和内容政策：导入后这部分不再显示 */
    rawHtml: string[]
  }
  closet: { duplicates: number }
  reports: { duplicates: number; autoResolved: number; refunded: number }
  /** 按导入的衣柜重新统计后，与旧库不同的收藏数 */
  likes: CappedList<{ tid: number; before: number; after: number }>
  /** 认不出的表，例如其他插件的数据，没有迁移 */
  unknownTables: { name: string; rows: number }[]
  verification: { checked: number; mismatches: CappedList<VerificationMismatch> }
  target: {
    /** 导入前目标库的数据 */
    before: TargetCounts
    lastImportAt: string | null
    newData: NewSiteData | null
  }
  /** 提交了的导入才有 */
  watermark: ImportWatermark | null
}
