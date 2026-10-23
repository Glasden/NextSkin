import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestDirectory } from '@nextskin/db/testing'
import { afterAll, afterEach, expect, test, vi } from 'vitest'
import { createLocalTextureStorage } from './storage.ts'

const listing = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async readdir(path: string, options: { withFileTypes: true }) {
      const entries = await fs.readdir(path, options)
      const afterRead = listing.afterRead
      listing.afterRead = undefined
      await afterRead?.()
      return entries
    },
  }
})
afterEach(() => {
  listing.afterRead = undefined
})

const directory = await mkdtemp(join(tmpdir(), 'nextskin-storage-'))
afterAll(async () => {
  await removeTestDirectory(directory)
})

// Windows 未开启开发者模式的账号可能没有文件符号链接权限，只在 EPERM 时跳过相关用例。
const supportsSymlinks = await (async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const target = join(directory, 'symlink-target')
  const link = join(directory, 'symlink-probe')
  await fs.writeFile(target, 'probe')
  try {
    await fs.symlink(target, link, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  } finally {
    await fs.rm(link, { force: true })
    await fs.rm(target, { force: true })
  }
})()

test('按 hash 返回原始字节，缺文件返回 null', async () => {
  const hash = 'a'.repeat(64)
  const bytes = Buffer.from([0, 255, 137, 80, 78, 71])
  await writeFile(join(directory, hash), bytes)
  const storage = createLocalTextureStorage(directory)
  expect(await storage.read(hash)).toEqual(bytes)
  expect(await storage.read('b'.repeat(64))).toBeNull()
})

test('stat 返回文件大小，缺文件返回 null，错误不暴露路径', async () => {
  const hash = 'c'.repeat(64)
  await writeFile(join(directory, hash), Buffer.alloc(1234))
  const storage = createLocalTextureStorage(directory)
  expect(await storage.stat(hash)).toEqual({ sizeBytes: 1234 })
  expect(await storage.stat('d'.repeat(64))).toBeNull()
  await expect(storage.stat('../outside')).rejects.toThrow('hash')
  await expect(createLocalTextureStorage('\0').stat(hash)).rejects.toThrow('读取材质文件信息失败')
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

test.skipIf(!supportsSymlinks)('列出对象只含小写 hash 普通文件，按键排序且严格按游标分页', async () => {
  const { mkdir, symlink, utimes } = await import('node:fs/promises')
  const path = join(directory, 'listing')
  await mkdir(path)
  const keys = ['c', 'a', 'b'].map((key) => key.repeat(64))
  const modifiedAt = new Date('2029-01-01T00:00:00Z')
  for (const key of [...keys, 'A'.repeat(64), 'notes', 'd'.repeat(63)]) await writeFile(join(path, key), 'test')
  for (const key of keys) await utimes(join(path, key), modifiedAt, modifiedAt)
  await mkdir(join(path, 'd'.repeat(64)))
  await symlink(join(path, keys[0]!), join(path, 'e'.repeat(64)))
  const storage = createLocalTextureStorage(path)
  expect(await storage.list({ after: null, limit: 2 })).toEqual([
    { key: 'a'.repeat(64), modifiedAt },
    { key: 'b'.repeat(64), modifiedAt },
  ])
  expect(await storage.list({ after: 'b'.repeat(64), limit: 2 })).toEqual([{ key: 'c'.repeat(64), modifiedAt }])
  expect(await storage.list({ after: 'c'.repeat(64), limit: 2 })).toEqual([])
})

test.skipIf(!supportsSymlinks)('列出临时文件跳过非法名字、目录和符号链接；缺目录返回空，异常不泄露路径', async () => {
  const { mkdir, symlink } = await import('node:fs/promises')
  const storage = createLocalTextureStorage(join(directory, 'missing'))
  expect(await storage.list({ after: null, limit: 1000 })).toEqual([])
  expect(await storage.listTemp()).toEqual([])
  const path = join(directory, 'temps'),
    hash = 'a'.repeat(64),
    claimId = '00000000-0000-4000-8000-000000000000'
  await mkdir(join(path, '.tmp'), { recursive: true })
  await writeFile(join(path, '.tmp', `${hash}.${claimId}`), 'temp')
  await writeFile(join(path, '.tmp', `${hash}.invalid`), 'temp')
  await writeFile(join(path, '.tmp', `${hash.toUpperCase()}.${claimId}`), 'temp')
  await mkdir(join(path, '.tmp', `${'b'.repeat(64)}.${claimId}`))
  await symlink(join(path, '.tmp', `${hash}.${claimId}`), join(path, '.tmp', `${'c'.repeat(64)}.${claimId}`))
  const listed = await createLocalTextureStorage(path).listTemp()
  expect(listed.map(({ hash, claimId }) => ({ hash, claimId }))).toEqual([{ hash, claimId }])
  expect(listed[0]!.modifiedAt).toBeInstanceOf(Date)
  await expect(createLocalTextureStorage('\0').list({ after: null, limit: 1 })).rejects.toThrow('列出材质文件失败')
  await expect(createLocalTextureStorage('\0').listTemp()).rejects.toThrow('列出材质文件失败')
})

test.skipIf(!supportsSymlinks).each(['list', 'listTemp'] as const)(
  '目录读出之后被替换的符号链接不会被 %s 跟随',
  async (method) => {
    const { mkdir, rm, symlink } = await import('node:fs/promises')
    const path = join(directory, `link-race-${method}`)
    const parent = method === 'list' ? path : join(path, '.tmp')
    await mkdir(parent, { recursive: true })
    const key = 'a'.repeat(64)
    const claimId = '00000000-0000-4000-8000-000000000000'
    const entry = join(parent, method === 'list' ? key : `${key}.${claimId}`)
    const target = join(path, 'link-target')
    await writeFile(entry, 'original')
    await writeFile(target, 'target')
    listing.afterRead = async () => {
      await rm(entry)
      await symlink(target, entry)
    }
    const storage = createLocalTextureStorage(path)
    if (method === 'list') await expect(storage.list({ after: null, limit: 1000 })).rejects.toThrow('材质文件失败')
    else expect(await storage.listTemp()).toEqual([])
  },
)
