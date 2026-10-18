import type { SerializedRequest, SerializedResponse } from './protocol.ts'

/** 请求体、响应体完整读入时的上限：超过就拒绝，不读完 */
export async function readBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (!body) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new BodyTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError'
  readonly maxBytes: number
  constructor(maxBytes: number) {
    super(`body exceeds ${maxBytes} bytes`)
    this.maxBytes = maxBytes
  }
}

export async function serializeRequest(request: Request, maxBytes: number): Promise<SerializedRequest> {
  return {
    method: request.method,
    url: request.url,
    headers: [...request.headers],
    body: await readBody(request.body, maxBytes),
  }
}

export function deserializeRequest(request: SerializedRequest, signal?: AbortSignal): Request {
  const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
  return new Request(request.url, {
    method: request.method,
    headers: [...request.headers.map(([name, value]) => [name, value] as [string, string])],
    body: hasBody ? (request.body as Uint8Array<ArrayBuffer>) : null,
    signal,
  })
}

export async function serializeResponse(response: Response, maxBytes: number): Promise<SerializedResponse> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body: await readBody(response.body, maxBytes),
  }
}

/** 101、204、205、304 不能带响应体 */
const NULL_BODY = new Set([101, 204, 205, 304])

export function deserializeResponse(response: SerializedResponse): Response {
  return new Response(NULL_BODY.has(response.status) ? null : (response.body as Uint8Array<ArrayBuffer> | null), {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.map(([name, value]) => [name, value] as [string, string])],
  })
}
