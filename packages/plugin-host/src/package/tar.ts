import { PluginPackageError } from './error.ts'

export interface TarFile {
  readonly path: string
  readonly bytes: Uint8Array
}
export interface TarLimits {
  readonly maxFiles: number
  readonly maxPathLength: number
  readonly maxDepth: number
  readonly maxBytes: number
}

const BLOCK = 512
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export function validatePackagePath(path: string, limits: Pick<TarLimits, 'maxPathLength' | 'maxDepth'>): void {
  const parts = path.split('/')
  if (
    encoder.encode(path).length > limits.maxPathLength ||
    parts.length > limits.maxDepth ||
    parts.some((p) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.exec(p)?.[0] !== p)
  )
    throw new PluginPackageError('invalid_path', '包内路径必须是合法的 POSIX 相对路径，且长度和深度不能超限')
}

function invalid(message: string): never {
  throw new PluginPackageError('invalid_archive', message)
}

function put(header: Uint8Array, offset: number, width: number, text: string) {
  const bytes = encoder.encode(text)
  if (bytes.length > width) invalid('tar 字段超长')
  header.set(bytes, offset)
}

function octal(header: Uint8Array, offset: number, width: number, value: number) {
  put(header, offset, width, value.toString(8).padStart(width - 1, '0') + '\0')
}

export function writeTar(files: readonly TarFile[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const { path, bytes } of files) {
    let name = path
    let prefix = ''
    if (encoder.encode(path).length > 100) {
      const split = [...path.matchAll(/\//g)]
        .reverse()
        .find(
          (m) =>
            encoder.encode(path.slice(0, m.index)).length <= 155 &&
            encoder.encode(path.slice(m.index + 1)).length <= 100,
        )
      if (!split) invalid('tar 路径无法放入 ustar 的 name 和 prefix 字段')
      prefix = path.slice(0, split.index)
      name = path.slice(split.index + 1)
    }
    const header = new Uint8Array(BLOCK)
    put(header, 0, 100, name)
    octal(header, 100, 8, 0o644)
    octal(header, 108, 8, 0)
    octal(header, 116, 8, 0)
    octal(header, 124, 12, bytes.length)
    octal(header, 136, 12, 0)
    header.fill(32, 148, 156)
    header[156] = 48
    put(header, 257, 6, 'ustar\0')
    put(header, 263, 2, '00')
    put(header, 345, 155, prefix)
    const checksum = header.reduce((sum, b) => sum + b, 0)
    put(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')
    chunks.push(header, bytes, new Uint8Array((BLOCK - (bytes.length % BLOCK)) % BLOCK))
  }
  chunks.push(new Uint8Array(BLOCK * 2))
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export function readTar(bytes: Uint8Array, limits: TarLimits): TarFile[] {
  if (bytes.length > limits.maxBytes) throw new PluginPackageError('too_large', '解压后的插件包超过大小上限')
  if (bytes.length % BLOCK) invalid('tar 长度不是完整的块')
  const files: TarFile[] = []
  const paths = new Set<string>()
  let entries = 0
  const field = (header: Uint8Array, start: number, width: number) => {
    const value = header.subarray(start, start + width)
    const end = value.indexOf(0)
    if (end >= 0 && value.subarray(end).some((b) => b !== 0)) invalid('tar 字段包含 NUL 后的非零数据')
    try {
      return decoder.decode(end < 0 ? value : value.subarray(0, end))
    } catch {
      return invalid('tar 字段不是合法 UTF-8')
    }
  }
  const number = (header: Uint8Array, start: number, width: number) => {
    const raw = new TextDecoder()
      .decode(header.subarray(start, start + width))
      .replace(/\0/g, ' ')
      .trim()
    if (!/^[0-7]+$/.test(raw)) invalid('tar 数字字段必须是八进制')
    const value = Number.parseInt(raw, 8)
    if (!Number.isSafeInteger(value)) invalid('tar 数字字段超限')
    return value
  }
  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    const header = bytes.subarray(offset, offset + BLOCK)
    if (header.every((b) => b === 0)) {
      if (offset + BLOCK * 2 > bytes.length || bytes.subarray(offset + BLOCK).some((b) => b !== 0))
        invalid('tar 必须以两个全零块结束，后面不能有其他数据')
      return files
    }
    const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0)
    if (number(header, 148, 8) !== sum) invalid('tar 头校验和不匹配')
    if (field(header, 257, 6) !== 'ustar' || field(header, 263, 2) !== '00') invalid('只支持 ustar 格式')
    const type = header[156]
    if (type !== 0 && type !== 48 && type !== 53)
      throw new PluginPackageError('unsupported_entry', 'tar 只允许普通文件和目录，不允许链接或扩展头')
    if (++entries > limits.maxFiles) throw new PluginPackageError('too_many_files', '插件包的文件数量超过上限')
    const prefix = field(header, 345, 155)
    const name = field(header, 0, 100)
    const fullPath = prefix ? `${prefix}/${name}` : name
    const path = type === 53 ? fullPath.replace(/\/$/, '') : fullPath
    validatePackagePath(path, limits)
    const folded = path.toLowerCase()
    if (paths.has(folded)) throw new PluginPackageError('duplicate_path', '插件包包含不区分大小写的重复路径')
    paths.add(folded)
    const size = number(header, 124, 12)
    const end = offset + BLOCK + size
    const next = offset + BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (end > bytes.length || next > bytes.length) invalid('tar 文件数据越界')
    if (type === 53 && size !== 0) invalid('tar 目录不能包含文件数据')
    if (type !== 53) files.push({ path, bytes: new Uint8Array(bytes.subarray(offset + BLOCK, end)) })
    offset = next
  }
  return invalid('tar 缺少两个全零结束块')
}
