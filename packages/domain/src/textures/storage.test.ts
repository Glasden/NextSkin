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
    await expect(storage.read(hash)).rejects.toThrow('hash')
  }
})

test('文件系统错误不当作文件缺失，且不暴露路径', async () => {
  await expect(createLocalTextureStorage('\0').read('a'.repeat(64))).rejects.toThrow('读取材质文件失败')
})

test('写入认领临时文件后原子改名；删除对象和临时文件幂等；本地 L=0', async () => {
  const { randomUUID } = await import('node:crypto')
  const hash = 'c'.repeat(64),
    claim = randomUUID(),
    bytes = Uint8Array.of(0, 1, 2, 255)
  const storage = createLocalTextureStorage(join(directory, 'new'))
  expect(storage.lateDeleteWindowMs).toBe(0)
  await storage.write(hash, claim, bytes)
  expect(new Uint8Array((await storage.read(hash))!)).toEqual(bytes)
  await storage.deleteTemp(hash, claim)
  await storage.delete(hash)
  await storage.delete(hash)
  expect(await storage.read(hash)).toBeNull()
  await writeFile(join(directory, 'new', '.tmp', `${hash}.${claim}`), bytes)
  await storage.deleteTemp(hash, claim)
  await storage.deleteTemp(hash, claim)
  const { access } = await import('node:fs/promises')
  await expect(access(join(directory, 'new', '.tmp', `${hash}.${claim}`))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('所有写操作校验 hash 和 UUID，不把非法键或文件路径写进异常', async () => {
  const storage = createLocalTextureStorage('\0'),
    hash = 'd'.repeat(64),
    claim = '00000000-0000-4000-8000-000000000000'
  await expect(storage.write('../outside', claim, new Uint8Array())).rejects.toThrow('hash')
  await expect(storage.delete('../outside')).rejects.toThrow('hash')
  await expect(storage.deleteTemp(hash, '../outside')).rejects.toThrow('UUID')
  await expect(storage.write(hash, '../outside', new Uint8Array())).rejects.toThrow('UUID')
  await expect(storage.write(hash, claim, new Uint8Array())).rejects.toThrow(/^写入或删除材质文件失败/)
  await expect(storage.delete(hash)).rejects.toThrow(/^写入或删除材质文件失败/)
})

test('清理先前认领的临时文件不影响新的认领', async () => {
  const { randomUUID } = await import('node:crypto')
  const hash = 'e'.repeat(64),
    oldClaim = randomUUID(),
    claim = randomUUID()
  const storage = createLocalTextureStorage(directory)
  await storage.write(hash, claim, Uint8Array.of(9))
  await storage.deleteTemp(hash, oldClaim)
  expect(new Uint8Array((await storage.read(hash))!)).toEqual(Uint8Array.of(9))
})
