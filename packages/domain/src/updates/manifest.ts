import { MANIFEST_URL, readManifest, type ReleaseEntry } from '@nextskin/updates'
import type { UpdateState } from './state.ts'

type Failure = { code: 'http'; status: number } | { code: Exclude<NonNullable<UpdateState['failure']>['code'], 'http'> }
export type ManifestResult = { releases: ReleaseEntry[]; rejected: number } | { failure: Failure }

export async function fetchUpdateManifest(options: {
  fetch?: typeof fetch
  keys?: Readonly<Record<string, string>>
}): Promise<ManifestResult> {
  const controller = new AbortController()
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), controller.signal])
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(MANIFEST_URL, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      signal,
    })
  } catch {
    return { failure: { code: 'network' } }
  }
  if (!response.ok) {
    controller.abort()
    await response.body?.cancel().catch(() => {})
    return { failure: { code: 'http', status: response.status } }
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader()
  if (!reader) return { failure: { code: 'invalid' } }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) {
        controller.abort()
        await reader.cancel().catch(() => {})
        return { failure: { code: 'too_large' } }
      }
      chunks.push(value)
    }
  } catch {
    return { failure: { code: 'network' } }
  } finally {
    reader.releaseLock()
  }
  try {
    return readManifest(Buffer.concat(chunks).toString('utf8'), options.keys)
  } catch {
    // 校验错误可能含远端原文，只保留机器码。
    return { failure: { code: 'invalid' } }
  }
}
