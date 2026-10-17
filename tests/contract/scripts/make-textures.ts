// 生成契约用例的材质文件和清单，只在增删材质时运行一次：node tests/contract/scripts/make-textures.ts
// 生成的 PNG 提交进仓库：文件字节随 zlib 版本变化，每次重新生成会改变 hash，录制结果就对不上了。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const directory = new URL('../fixtures/textures/', import.meta.url)

interface Spec {
  file: string
  width: number
  height: number
  seed: number
}

const specs: Spec[] = [
  { file: 'steve-64x64.png', width: 64, height: 64, seed: 1 },
  { file: 'alex-64x64.png', width: 64, height: 64, seed: 2 },
  { file: 'legacy-64x32.png', width: 64, height: 32, seed: 3 },
  { file: 'hd-128x128.png', width: 128, height: 128, seed: 4 },
  { file: 'cape-64x32.png', width: 64, height: 32, seed: 5 },
  // 数据库里有记录、存储里没有文件的材质（BS 删除文件或迁移时丢失文件后的状态），只用来算 hash
  { file: 'ghost-64x64.png', width: 64, height: 64, seed: 6 },
]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function pixels({ width, height, seed }: Spec): Buffer {
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      rgba[offset] = (x * 3 + seed * 40) & 0xff
      rgba[offset + 1] = (y * 5 + seed * 70) & 0xff
      rgba[offset + 2] = ((x ^ y) * 7 + seed * 20) & 0xff
      // 留一块透明区域，像真实皮肤的第二层
      rgba[offset + 3] = x >= width / 2 && y < height / 4 ? 0 : 0xff
    }
  }
  return rgba
}

function encode(spec: Spec, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(spec.width, 0)
  header.writeUInt32BE(spec.height, 4)
  header[8] = 8 // 位深
  header[9] = 6 // RGBA
  const stride = spec.width * 4
  const raw = Buffer.alloc((stride + 1) * spec.height)
  for (let y = 0; y < spec.height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function pixelHash(spec: Spec, rgba: Buffer): string {
  const size = Buffer.alloc(8)
  size.writeUInt32BE(spec.width, 0)
  size.writeUInt32BE(spec.height, 4)
  return createHash('sha256').update(size).update(rgba).digest('hex')
}

mkdirSync(directory, { recursive: true })
const manifest = specs.map((spec) => {
  const rgba = pixels(spec)
  const file = encode(spec, rgba)
  writeFileSync(new URL(spec.file, directory), file)
  return {
    file: spec.file,
    width: spec.width,
    height: spec.height,
    sizeBytes: file.length,
    // BS 的 hash：文件字节的 sha256。导入后原样保留（ADR-0006）
    hash: createHash('sha256').update(file).digest('hex'),
    pixelHash: pixelHash(spec, rgba),
  }
})
writeFileSync(new URL('manifest.json', directory), JSON.stringify(manifest, null, 2) + '\n')
console.log(manifest)
