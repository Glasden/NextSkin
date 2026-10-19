// 后台列表的筛选条件和页码都在地址里，同皮肤库（skinlib/params.ts）：可以收藏、分享，翻页不需要 JS

import type { UserRole } from '@nextskin/domain'

/** 后台表格每页 50 行（ADR-0027） */
export const ADMIN_PER_PAGE = 50

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

function parsePage(value: string): number {
  return /^[1-9]\d{0,5}$/.test(value) ? Number(value) : 1
}

/** 正整数 id（uid、tid……），不超过 INT 的上限 */
export function parseId(value: string): number | null {
  return /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null
}

function withQuery(path: string, query: URLSearchParams): string {
  const search = query.toString()
  return search ? `${path}?${search}` : path
}

export const REPORT_STATUSES = ['pending', 'resolved', 'rejected'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export interface ReportParams {
  status: ReportStatus
  page: number
}

/** 不认识的值一律取默认值，不报错：地址可能是手改的 */
export function parseReportParams(search: SearchParams): ReportParams {
  const status = first(search.status)
  return {
    status: (REPORT_STATUSES as readonly string[]).includes(status) ? (status as ReportStatus) : 'pending',
    page: parsePage(first(search.page)),
  }
}

/** 换了状态就回到第一页；默认值不写进地址 */
export function reportsHref(params: ReportParams, changes: Partial<ReportParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.status !== 'pending') query.set('status', next.status)
  if (next.page > 1) query.set('page', String(next.page))
  return withQuery('/admin/reports', query)
}

export const USER_ROLE_FILTERS = ['all', 'user', 'admin', 'superadmin', 'banned'] as const
export type UserRoleFilter = (typeof USER_ROLE_FILTERS)[number]

export interface UserParams {
  q: string
  role: UserRoleFilter
  page: number
}

export function parseUserParams(search: SearchParams): UserParams {
  const role = first(search.role)
  return {
    q: first(search.q).trim().slice(0, 64),
    role: (USER_ROLE_FILTERS as readonly string[]).includes(role) ? (role as UserRoleFilter) : 'all',
    page: parsePage(first(search.page)),
  }
}

export function usersHref(params: UserParams, changes: Partial<UserParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.q) query.set('q', next.q)
  if (next.role !== 'all') query.set('role', next.role)
  if (next.page > 1) query.set('page', String(next.page))
  return withQuery('/admin/users', query)
}

export function roleOrNull(filter: UserRoleFilter): UserRole | undefined {
  return filter === 'all' ? undefined : filter
}

export interface AuditParams {
  /** 只看某个对象的记录：`?subject=texture:12` */
  subject: { type: string; id: number } | null
  /** 只看某个操作者的记录：`?actor=5` */
  actor: number | null
  page: number
}

export function parseAuditParams(search: SearchParams): AuditParams {
  const subject = /^([a-z][a-zA-Z]{0,31}):([1-9]\d{0,9})$/.exec(first(search.subject))
  const subjectId = subject ? parseId(subject[2]!) : null
  return {
    subject: subject && subjectId !== null ? { type: subject[1]!, id: subjectId } : null,
    actor: parseId(first(search.actor)),
    page: parsePage(first(search.page)),
  }
}

export function auditHref(params: AuditParams, changes: Partial<AuditParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.subject) query.set('subject', `${next.subject.type}:${next.subject.id}`)
  if (next.actor !== null) query.set('actor', String(next.actor))
  if (next.page > 1) query.set('page', String(next.page))
  return withQuery('/admin/audit', query)
}

export interface PlayerParams {
  /** 角色名（包含匹配）或 UUID（精确） */
  q: string
  /** 只看某个用户的角色：`?owner=5`，用户详情页链接到这里 */
  owner: number | null
  page: number
}

export function parsePlayerParams(search: SearchParams): PlayerParams {
  return {
    // UUID 带连字符是 36 个字符
    q: first(search.q).trim().slice(0, 64),
    owner: parseId(first(search.owner)),
    page: parsePage(first(search.page)),
  }
}

export function playersHref(params: PlayerParams, changes: Partial<PlayerParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.q) query.set('q', next.q)
  if (next.owner !== null) query.set('owner', String(next.owner))
  if (next.page > 1) query.set('page', String(next.page))
  return withQuery('/admin/players', query)
}

/** 用户详情页衣柜节的页码（`?closet=`）：每页 50 行，翻页回到衣柜节（ADR-0036"页面"） */
export function parseClosetPage(search: SearchParams): number {
  return parsePage(first(search.closet))
}

export function closetHref(uid: number, page: number): string {
  return page > 1 ? `/admin/users/${uid}?closet=${page}#closet` : `/admin/users/${uid}#closet`
}
