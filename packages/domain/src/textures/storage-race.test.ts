import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createLocalTextureStorage } from './storage.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async rename(from: string, to: string) {
      // 模拟租期清理在 writeFile 完成后、rename 前删除临时文件。
      await fs.rm(from)
      return fs.rename(from, to)
    },
  }
})

test('临时文件被清理后 write 必须失败，不产生最终文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nextskin-storage-race-')),
    hash = 'a'.repeat(64)
  try {
    const storage = createLocalTextureStorage(directory)
    await expect(storage.write(hash, '00000000-0000-4000-8000-000000000000', Uint8Array.of(1))).rejects.toThrow(
      '写入或删除材质文件失败',
    )
    expect(await storage.read(hash)).toBeNull()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
