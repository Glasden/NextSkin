// 皮肤库的筛选条件都在地址里：可以收藏、分享，翻页不需要 JS

export const LIBRARY_TYPES = ['skin', 'steve', 'alex', 'cape'] as const
export const LIBRARY_SORTS = ['latest', 'popular'] as const
export const PER_PAGE = 20

export interface LibraryParams {
  type: (typeof LIBRARY_TYPES)[number]
  sort: (typeof LIBRARY_SORTS)[number]
  q: string
  uploader: number | null
  page: number
}

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T {
  return (values as readonly string[]).includes(value) ? (value as T) : fallback
}

/** 不认识的值一律取默认值，不报错：地址可能是手改的，也可能来自旧版本 */
export function parseLibraryParams(search: SearchParams): LibraryParams {
  const uploader = first(search.uploader)
  const page = first(search.page)
  return {
    type: oneOf(LIBRARY_TYPES, first(search.type), 'skin'),
    sort: oneOf(LIBRARY_SORTS, first(search.sort), 'latest'),
    q: first(search.q).trim().slice(0, 64),
    uploader: /^[1-9]\d{0,9}$/.test(uploader) && Number(uploader) <= 2147483647 ? Number(uploader) : null,
    page: /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
  }
}

/** 换了筛选条件就回到第一页；默认值不写进地址 */
export function libraryHref(params: LibraryParams, changes: Partial<LibraryParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.type !== 'skin') query.set('type', next.type)
  if (next.sort !== 'latest') query.set('sort', next.sort)
  if (next.q) query.set('q', next.q)
  if (next.uploader !== null) query.set('uploader', String(next.uploader))
  if (next.page > 1) query.set('page', String(next.page))
  const search = query.toString()
  return search ? `/skinlib?${search}` : '/skinlib'
}
