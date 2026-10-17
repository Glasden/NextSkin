import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createLocalTextureStorage } from './storage.ts'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp('/tmp/nextskin-storage-')
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('按 hash 返回原始字节，缺文件返回 null', async () => {
  const hash = 'a'.repeat(64)
  const bytes = Buffer.from([0, 255, 137, 80, 78, 71])
  await writeFile(join(directory, hash), bytes)
  const storage = createLocalTextureStorage(directory)
  expect(await storage.read(hash)).toEqual(bytes)
  expect(await storage.read('b'.repeat(64))).toBeNull()
})

test('非法 hash 不访问文件系统', async () => {
  // 目录本身非法；若尝试 readFile，将抛出 ENOTDIR 而非返回 null。
  const storage = createLocalTextureStorage('\0')
  for (const hash of ['../outside', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '/extra', '']) {
    expect(await storage.read(hash)).toBeNull()
  }
})

test('文件系统错误不当作文件缺失，且不暴露路径', async () => {
  await expect(createLocalTextureStorage('\0').read('a'.repeat(64))).rejects.toThrow('读取材质文件失败')
})
