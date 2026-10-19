// 浏览器里调用自己的 API（ADR-0004：网页的写操作走公开 API）

export interface FieldError {
  code: string
  message: string
}

/** REST 接口的错误（ADR-0019）：message 已经按请求的语言翻译 */
export interface ApiError extends FieldError {
  fields?: Record<string, FieldError>
}

/** 发一个 JSON 请求。网络断开、服务端没有返回 JSON 时，status 为 0 或 data 为 null */
export function postJson(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return sendJson('POST', path, body)
}

/**
 * 没有请求体的 DELETE 和 POST 也带上 JSON 的 Content-Type：跨站的页面发不出这种请求（要先过 CORS 预检），
 * 不带的话接口按表单请求检查 Origin（hono/csrf）
 */
export async function sendJson(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: { redirect?: RequestRedirect } = {},
): Promise<{ status: number; data: unknown }> {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: options.redirect,
    })
    return { status: response.status, data: await response.json().catch(() => null) }
  } catch {
    return { status: 0, data: null }
  }
}

/** 发一个 multipart 表单，例如上传材质。Content-Type 由浏览器按 FormData 填，带上分隔符 */
export async function postForm(path: string, body: FormData): Promise<{ status: number; data: unknown }> {
  try {
    const response = await fetch(path, { method: 'POST', body })
    return { status: response.status, data: await response.json().catch(() => null) }
  } catch {
    return { status: 0, data: null }
  }
}

/** GET 一个 JSON 接口，例如 Better Auth 生成通行密钥参数的接口 */
export async function getJson(path: string): Promise<{ status: number; data: unknown }> {
  try {
    const response = await fetch(path, { headers: { Accept: 'application/json' } })
    return { status: response.status, data: await response.json().catch(() => null) }
  } catch {
    return { status: 0, data: null }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** REST 接口的错误响应 { error: { code, message, fields? } } */
export function apiError(data: unknown): ApiError | null {
  if (!isRecord(data) || !isRecord(data.error)) return null
  const { code, message, fields } = data.error
  if (typeof code !== 'string' || typeof message !== 'string') return null
  return { code, message, fields: isRecord(fields) ? (fields as Record<string, FieldError>) : undefined }
}

/** 字段错误转成 Form 的 errors：字段名 → 文案 */
export function formErrors(error: ApiError): Record<string, string> {
  return Object.fromEntries(Object.entries(error.fields ?? {}).map(([name, field]) => [name, field.message]))
}

/** Better Auth（/api/auth/*）的错误码：它的错误响应是 { code, message }，message 是英文，网页按 code 翻译 */
export function authErrorCode(data: unknown): string | null {
  return isRecord(data) && typeof data.code === 'string' ? data.code : null
}
