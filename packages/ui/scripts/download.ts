import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** 下载文件并校验 sha256，存到 target。target 已存在时直接读取，同样校验 */
export async function download(source: { url: string; sha256: string }, target: URL): Promise<Uint8Array> {
  const cached = existsSync(target)
  let data: Uint8Array
  if (cached) {
    data = readFileSync(target)
  } else {
    console.log(`下载 ${source.url}`)
    const res = await fetch(source.url)
    if (!res.ok) throw new Error(`下载失败：${res.status} ${source.url}`)
    data = new Uint8Array(await res.arrayBuffer())
  }
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== source.sha256) throw new Error(`${source.url} 的 sha256 是 ${actual}，与记录的不符`)
  if (!cached) {
    mkdirSync(new URL('.', target), { recursive: true })
    writeFileSync(target, data)
  }
  return data
}
