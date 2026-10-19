import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { PluginManifest } from '@nextskin/plugin-sdk'
import { PluginPackageError } from './error.ts'
import { parsePluginManifest } from './manifest-schema.ts'
import { readTar, validatePackagePath, writeTar, type TarFile } from './tar.ts'

export { PluginPackageError, type PluginPackageErrorCode } from './error.ts'
export const MAX_PACKAGE_BYTES = 10 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
/** 文案会随 init 帧发送给 host，限制每个插件的原始文案总字节数。 */
export const MAX_LOCALE_BYTES = 1024 * 1024
export const MAX_PACKAGE_FILES = 1000
export const MAX_PACKAGE_PATH_LENGTH = 200
export const MAX_PACKAGE_DEPTH = 8
const limits = {
  maxBytes: MAX_UNPACKED_BYTES,
  maxFiles: MAX_PACKAGE_FILES,
  maxPathLength: MAX_PACKAGE_PATH_LENGTH,
  maxDepth: MAX_PACKAGE_DEPTH,
}
const encoder = new TextEncoder()

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readJson(bytes: Uint8Array, code: 'invalid_manifest' | 'invalid_locale'): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new PluginPackageError(
      code,
      code === 'invalid_manifest' ? 'manifest.json 不是合法的 JSON' : 'locales 文案文件不是合法的 JSON',
    )
  }
}

export function packPluginPackage({
  manifest,
  files,
}: {
  manifest: PluginManifest
  files: ReadonlyMap<string, Uint8Array> | readonly TarFile[]
}): Uint8Array {
  const entries: TarFile[] = Array.isArray(files)
    ? [...(files as readonly TarFile[])]
    : [...(files as ReadonlyMap<string, Uint8Array>)].map(([path, bytes]) => ({ path, bytes }))
  for (const { path } of entries) validatePackagePath(path, limits)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // 只给 integrity 的键排序：设置项、权限的先后就是后台表单里的顺序，不能动。
  // 同一份定义提取出的其余部分键序是固定的，包仍然逐字节相同
  const parsed = parsePluginManifest(manifest)
  const text = JSON.stringify({
    ...parsed,
    integrity: Object.fromEntries(Object.entries(parsed.integrity).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  })
  entries.unshift({ path: 'manifest.json', bytes: encoder.encode(text) })
  if (entries.length > MAX_PACKAGE_FILES) throw new PluginPackageError('too_many_files', '插件包的文件数量超过上限')
  if (entries.reduce((n, f) => n + 512 + Math.ceil(f.bytes.length / 512) * 512, 1024) > MAX_UNPACKED_BYTES)
    throw new PluginPackageError('too_large', '解压后的插件包超过大小上限')
  const result = gzipSync(writeTar(entries), { level: 9 })
  // gzip 头的操作系统字节固定，避免 Windows 和 Unix 的头信息不同。
  result[9] = 255
  if (result.length > MAX_PACKAGE_BYTES) throw new PluginPackageError('too_large', '压缩后的插件包不能超过 10 MiB')
  return result
}

export function unpackPluginPackage(bytes: Uint8Array): {
  manifest: PluginManifest
  files: ReadonlyMap<string, Uint8Array>
  messages: Record<string, Record<string, unknown>>
} {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new PluginPackageError('too_large', '压缩后的插件包不能超过 10 MiB')
  let tar: Uint8Array
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE')
      throw new PluginPackageError('too_large', '解压后的插件包超过 64 MiB')
    throw new PluginPackageError('invalid_archive', '插件包不是合法的 gzip 文件')
  }
  const files = new Map(readTar(tar, limits).map(({ path, bytes }) => [path, bytes]))
  const raw = files.get('manifest.json')
  if (!raw) throw new PluginPackageError('missing_manifest', '插件包根目录缺少 manifest.json')
  const manifest = parsePluginManifest(readJson(raw, 'invalid_manifest'))
  const entry = manifest.entry.server
  if (!entry || !entry.endsWith('.mjs') || !files.has(entry))
    throw new PluginPackageError('missing_entry', 'entry.server 必须指向包内的 .mjs 文件')
  const expected = [...files.keys()].filter((path) => path !== 'manifest.json')
  if (
    Object.keys(manifest.integrity).length !== expected.length ||
    expected.some(
      (path) => !Object.hasOwn(manifest.integrity, path) || manifest.integrity[path] !== sha256Hex(files.get(path)!),
    )
  )
    throw new PluginPackageError(
      'integrity_mismatch',
      'integrity 必须列出包内除 manifest.json 外的全部文件，且 sha256 必须一致',
    )
  const messages: Record<string, Record<string, unknown>> = {}
  let localeBytes = 0
  for (const [path, content] of files) {
    if (path.startsWith('locales/')) {
      localeBytes += content.byteLength
      if (localeBytes > MAX_LOCALE_BYTES)
        throw new PluginPackageError('locales_too_large', 'locales 文案文件合计不能超过 1 MiB')
      const match = /^locales\/([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/.exec(path)
      if (!match) throw new PluginPackageError('invalid_locale', 'locales 下只能有以合法语言名命名的 JSON 文案文件')
      const value = readJson(content, 'invalid_locale')
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new PluginPackageError('invalid_locale', 'locales 文案文件的根值必须是 JSON 对象')
      messages[match[1]!] = value as Record<string, unknown>
    } else if (path !== 'manifest.json' && path !== entry) {
      throw new PluginPackageError('unsupported_entry', '包内只允许 manifest.json、服务端入口和 locales 文案文件')
    }
  }
  return { manifest, files, messages }
}
