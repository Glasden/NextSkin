import { expect, test } from 'vitest'
import { createMemorySiteImageStorage, siteImageFile } from './storage.ts'
import { createSiteImageSweep } from './sweep.ts'

const day = 86_400_000
const [logo, favicon, old, fresh] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64)) as [string, string, string, string]

test('删掉一天以前写的、当前设置都没引用的图，连同白底的那份', async () => {
  let clock = 0
  const storage = createMemorySiteImageStorage(() => new Date(clock))
  for (const hash of [logo, favicon, old]) {
    await storage.write(siteImageFile(hash), Uint8Array.of(1))
    await storage.write(siteImageFile(hash, 'opaque'), Uint8Array.of(2))
  }
  clock = 2 * day
  await storage.write(siteImageFile(fresh), Uint8Array.of(3))
  const lines: string[] = []
  const sweep = createSiteImageSweep({
    storage,
    settings: { read: () => Promise.resolve({ 'site.logo': logo, 'site.favicon': favicon }) as never },
    now: () => new Date(clock + day / 2),
    log: (line) => lines.push(line),
  })
  await sweep.run({ jobId: 1, payload: null, attempt: 1, signal: new AbortController().signal })
  expect((await storage.list()).map((entry) => entry.file).sort()).toEqual(
    [
      siteImageFile(logo),
      siteImageFile(logo, 'opaque'),
      siteImageFile(favicon),
      siteImageFile(favicon, 'opaque'),
      siteImageFile(fresh),
    ].sort(),
  )
  expect(lines).toEqual(['[site-images] sweep deleted=2'])
})
