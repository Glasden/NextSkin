// 测试用的材质文件、目录和导入参数
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreDatabase } from '@nextskin/db'
import { removeTestDirectory, type TestDatabase } from '@nextskin/db/testing'
import { createImagePool, createLocalTextureStorage, type ImagePool } from '@nextskin/domain/importer'
import { samplePng } from '../../../skin/test/png-corpus.ts'
import { runImport, type ImportOptions } from '../engine.ts'
import { parseSourceDsn, type SourceConnection } from '../source/connection.ts'
import type { SourceDatabase } from '../source/schema.ts'
import { fileHash } from './bs.ts'

export const SECRET = 'importer-test-secret-0123456789abcdef'

export interface Png {
  bytes: Uint8Array
  hash: string
  width: number
  height: number
  rgba: Uint8Array
}

function png(colorType: number, interlace: number, width: number, height: number): Png {
  const sample = samplePng(colorType, 8, interlace, width, height)
  const bytes = new Uint8Array(sample.bytes)
  return { bytes, hash: fileHash(bytes), width, height, rgba: sample.expected.data }
}

/** 测试用的材质文件。interlaced 和 steve 像素相同、字节不同 */
export const pngs = {
  steve: png(6, 0, 64, 64),
  alex: png(2, 0, 64, 64),
  narrowCape: png(6, 0, 22, 17),
  odd: png(6, 0, 100, 50),
  interlaced: png(6, 1, 64, 64),
}
export const garbage = new TextEncoder().encode('this is not a png')
export const garbageHash = fileHash(garbage)
export const missingHash = 'f'.repeat(64)

/** 像素 hash：sha256(u32be(宽) ‖ u32be(高) ‖ RGBA8)（不变量 3） */
export function pixelHash(width: number, height: number, rgba: Uint8Array): string {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  return createHash('sha256').update(header).update(rgba).digest('hex')
}

/** 窄披风 22×17 补宽到 64×32 */
export function paddedCapeHash(image: Png): string {
  const out = new Uint8Array(64 * 32 * 4)
  for (let y = 0; y < image.height; y++)
    out.set(image.rgba.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * 64 * 4)
  return pixelHash(64, 32, out)
}

export interface Environment {
  texturesDirectory: string
  /** NextSkin 的材质存储，每个用例一个（resetStorage） */
  storageDirectory: string
  pool: ImagePool
  resetStorage(): Promise<void>
  cleanup(): Promise<void>
}

/** 旧站的材质目录（按 hash 命名的文件）和 NextSkin 的材质存储 */
export async function createEnvironment(): Promise<Environment> {
  const texturesDirectory = await mkdtemp(join(tmpdir(), 'nextskin-bs-textures-'))
  for (const file of Object.values(pngs)) await writeFile(join(texturesDirectory, file.hash), file.bytes)
  await writeFile(join(texturesDirectory, garbageHash), garbage)
  const pool = createImagePool({ size: 2 })
  const env: Environment = {
    texturesDirectory,
    storageDirectory: await mkdtemp(join(tmpdir(), 'nextskin-import-storage-')),
    pool,
    async resetStorage() {
      await removeTestDirectory(env.storageDirectory)
      env.storageDirectory = await mkdtemp(join(tmpdir(), 'nextskin-import-storage-'))
    },
    async cleanup() {
      await pool.close()
      await removeTestDirectory(texturesDirectory)
      await removeTestDirectory(env.storageDirectory)
    },
  }
  return env
}

export function sourceConnection(source: TestDatabase<SourceDatabase>): SourceConnection {
  const config = source.config
  return config.dialect === 'sqlite'
    ? { dialect: 'sqlite', file: config.file }
    : parseSourceDsn(config.url, process.cwd())
}

export function importer(
  env: Environment,
  source: TestDatabase<SourceDatabase>,
  target: TestDatabase<CoreDatabase>,
  defaults: Partial<ImportOptions> = {},
) {
  return (options: Partial<ImportOptions> = {}) =>
    runImport({
      db: target.db,
      source: sourceConnection(source),
      prefix: '',
      texturesDirectory: env.texturesDirectory,
      timeZone: 'Asia/Shanghai',
      passwordMethod: null,
      salt: '',
      dryRun: false,
      replace: false,
      force: false,
      entry: 'cli',
      // 用例之间会换存储目录，每次运行时再取
      storage: createLocalTextureStorage(env.storageDirectory),
      imagePool: env.pool,
      secretKey: SECRET,
      ...defaults,
      ...options,
    })
}
