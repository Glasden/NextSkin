import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTestDirectory } from '@nextskin/db/testing'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  createLocalSiteImageStorage,
  createMemorySiteImageStorage,
  siteImageFile,
  type SiteImageStorage,
} from './storage.ts'

let directory: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nextskin-site-images-'))
})
afterAll(async () => {
  if (directory) await removeTestDirectory(directory)
})

const hash = 'a'.repeat(64)
const bytes = Uint8Array.of(137, 80, 78, 71)

test.each<[string, () => SiteImageStorage]>([
  ['本地', () => createLocalSiteImageStorage(join(directory, 'images'))],
  ['内存', () => createMemorySiteImageStorage()],
])('%s驱动：按文件名读写、列出和删除', async (_, create) => {
  const storage = create()
  expect(await storage.list()).toEqual([])
  expect(await storage.read(siteImageFile(hash))).toBeNull()
  expect(await storage.has(siteImageFile(hash))).toBe(false)
  await storage.write(siteImageFile(hash, 'opaque'), bytes)
  await storage.write(siteImageFile(hash), bytes)
  expect(await storage.read(siteImageFile(hash))).toEqual(bytes)
  expect(await storage.has(siteImageFile(hash))).toBe(true)
  expect((await storage.list()).map((entry) => entry.file).sort()).toEqual([`${hash}.opaque.png`, `${hash}.png`])
  await storage.delete(siteImageFile(hash))
  expect(await storage.has(siteImageFile(hash))).toBe(false)
  expect(await storage.has(siteImageFile(hash, 'opaque'))).toBe(true)
})

test('文件名不对时直接拒绝，不碰文件系统', async () => {
  const storage = createLocalSiteImageStorage(directory)
  for (const file of ['../x.png', `${hash}.jpg`, `${'A'.repeat(64)}.png`, `${hash}.png/..`, 'favicon.ico']) {
    await expect(storage.read(file)).rejects.toThrow('文件名不合法')
    await expect(storage.write(file, bytes)).rejects.toThrow('文件名不合法')
  }
  expect(() => siteImageFile('abc')).toThrow()
})

test('列出写到一半留下的临时文件，清理任务能删掉；别的文件不列出', async () => {
  const dir = join(directory, 'leftover')
  const storage = createLocalSiteImageStorage(dir)
  await storage.write(siteImageFile(hash), bytes)
  const temp = `${hash}.png.123e4567-e89b-12d3-a456-426614174000.tmp`
  await writeFile(join(dir, temp), bytes)
  await writeFile(join(dir, 'notes.txt'), 'x')
  expect((await storage.list()).map((entry) => entry.file).sort()).toEqual([`${hash}.png`, temp])
  await storage.delete(temp)
  expect((await storage.list()).map((entry) => entry.file)).toEqual([`${hash}.png`])
})
