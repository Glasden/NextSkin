import { expect, test } from 'vitest'
import worker, { type ReleaseBucket } from './worker.ts'

const objects = new Map([
  ['releases/v1.json', '{"schema":1,"releases":[]}'],
  ['releases/0.5.0/nextskin-0.5.0.zip', 'zip'],
  ['secret.txt', 'private'],
])

const bucket: ReleaseBucket = {
  get(key) {
    const value = objects.get(key)
    return Promise.resolve(
      value === undefined ? null : { body: new Response(value).body!, size: value.length, httpEtag: `"${key.length}"` },
    )
  },
  head(key) {
    const value = objects.get(key)
    return Promise.resolve(value === undefined ? null : { size: value.length, httpEtag: `"${key.length}"` })
  },
}

const fetch = (path: string, method = 'GET') =>
  worker.fetch(new Request(`https://dl.nextskin.org${path}`, { method }), { RELEASES: bucket })

test('读出清单和 ZIP，带各自的类型和缓存', async () => {
  const manifest = await fetch('/releases/v1.json')
  expect(manifest.status).toBe(200)
  expect(await manifest.text()).toBe('{"schema":1,"releases":[]}')
  expect(manifest.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
  expect(manifest.headers.get('Cache-Control')).toBe('public, max-age=300')

  const archive = await fetch('/releases/0.5.0/nextskin-0.5.0.zip')
  expect(archive.status).toBe(200)
  expect(await archive.text()).toBe('zip')
  expect(archive.headers.get('Content-Type')).toBe('application/zip')
  expect(archive.headers.get('Content-Length')).toBe('3')
  expect(archive.headers.get('Cache-Control')).toContain('immutable')
})

test('HEAD 不带正文', async () => {
  const response = await fetch('/releases/0.5.0/nextskin-0.5.0.zip', 'HEAD')
  expect(response.status).toBe(200)
  expect(response.headers.get('Content-Length')).toBe('3')
  expect(await response.text()).toBe('')
})

test.each([
  '/secret.txt',
  '/releases/0.5.0/nextskin-0.4.0.zip',
  '/releases/0.5.0/other.zip',
  '/releases/v2.json',
  '/releases/0.6.0/nextskin-0.6.0.zip',
])('清单和 ZIP 以外的键、不存在的版本一律 404：%s', async (path) => {
  expect((await fetch(path)).status).toBe(404)
})

test('只接受 GET、HEAD', async () => {
  const response = await fetch('/releases/v1.json', 'PUT')
  expect(response.status).toBe(405)
  expect(response.headers.get('Allow')).toBe('GET, HEAD')
})
