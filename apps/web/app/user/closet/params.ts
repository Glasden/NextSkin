// 衣柜的分类、搜索和页码都在地址里，同皮肤库（skinlib/params.ts）

export const CLOSET_TYPES = ['skin', 'cape'] as const
export const PER_PAGE = 20

export interface ClosetParams {
  type: (typeof CLOSET_TYPES)[number]
  q: string
  page: number
}

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** 不认识的值一律取默认值，不报错 */
export function parseClosetParams(search: SearchParams): ClosetParams {
  const page = first(search.page)
  return {
    type: first(search.type) === 'cape' ? 'cape' : 'skin',
    q: first(search.q).trim().slice(0, 64),
    page: /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
  }
}

/** 换了分类或搜索就回到第一页；默认值不写进地址 */
export function closetHref(params: ClosetParams, changes: Partial<ClosetParams> = {}): string {
  const next = { ...params, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.type !== 'skin') query.set('type', next.type)
  if (next.q) query.set('q', next.q)
  if (next.page > 1) query.set('page', String(next.page))
  const search = query.toString()
  return search ? `/user/closet?${search}` : '/user/closet'
}
