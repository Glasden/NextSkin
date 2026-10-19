import { gzipSync } from 'node:zlib'
import { definePlugin } from '@nextskin/plugin-sdk'
import { expect, test } from 'vitest'
import { buildManifest } from '../manifest.ts'
import {
  MAX_LOCALE_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_UNPACKED_BYTES,
  packPluginPackage,
  PluginPackageError,
  sha256Hex,
  unpackPluginPackage,
} from './archive.ts'
import { writeTar } from './tar.ts'

const encode = (text: string) => new TextEncoder().encode(text)
const server = encode('export default {}')
const files = new Map([
  ['server.mjs', server],
  ['locales/en.json', encode('{"plugin":{"name":"Test"}}')],
])
const manifest = {
  ...buildManifest(definePlugin({ capabilities: [] }), { name: 'test', version: '1.0.0', nextskin: { id: 'test' } }),
  entry: { server: 'server.mjs' },
  integrity: Object.fromEntries([...files].map(([p, b]) => [p, sha256Hex(b)])),
}
const rawPackage = (m: unknown, entries = files) =>
  gzipSync(
    writeTar([
      { path: 'manifest.json', bytes: encode(JSON.stringify(m)) },
      ...[...entries].map(([path, bytes]) => ({ path, bytes })),
    ]),
  )

test('稳定打包、清单第一、按路径排序、解包文案和摘要', () => {
  const first = packPluginPackage({ manifest, files })
  const second = packPluginPackage({
    manifest: { ...manifest, integrity: Object.fromEntries(Object.entries(manifest.integrity).reverse()) },
    files: new Map([...files].reverse()),
  })
  expect(first).toEqual(second)
  const result = unpackPluginPackage(first)
  expect([...result.files.keys()]).toEqual(['manifest.json', 'locales/en.json', 'server.mjs'])
  expect(result.manifest).toEqual(manifest)
  expect(result.messages).toEqual({ en: { plugin: { name: 'Test' } } })
  expect(result.files.get('server.mjs')).toEqual(server)
  expect(sha256Hex(encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test.each([
  ['missing_manifest', () => gzipSync(writeTar([]))],
  ['invalid_manifest', () => rawPackage({ ...manifest, extra: true })],
  ['invalid_manifest', () => gzipSync(writeTar([{ path: 'manifest.json', bytes: encode('{') }]))],
  ['invalid_manifest', () => rawPackage({ ...manifest, entry: { server: null } })],
  ['missing_entry', () => rawPackage({ ...manifest, entry: { server: 'missing.mjs' } })],
  ['missing_entry', () => rawPackage({ ...manifest, entry: { server: 'locales/en.json' } })],
  ['integrity_mismatch', () => rawPackage({ ...manifest, integrity: {} })],
  [
    'integrity_mismatch',
    () => rawPackage({ ...manifest, integrity: { ...manifest.integrity, 'extra.mjs': 'a'.repeat(64) } }),
  ],
  [
    'integrity_mismatch',
    () => rawPackage({ ...manifest, integrity: { ...manifest.integrity, 'server.mjs': 'a'.repeat(64) } }),
  ],
  ['invalid_archive', () => encode('invalid')],
  [
    'duplicate_path',
    () =>
      gzipSync(
        writeTar([
          { path: 'server.mjs', bytes: server },
          { path: 'Server.mjs', bytes: server },
        ]),
      ),
  ],
] as const)('包校验失败：%s', (code, make) => {
  expect(() => unpackPluginPackage(make())).toThrow(PluginPackageError)
  expect(() => unpackPluginPackage(make())).toThrow(expect.objectContaining({ code }))
})

test.each([
  ['locales/EN.json', '{}'],
  ['locales/en_US.json', '{}'],
  ['locales/en/nested.json', '{}'],
  ['locales/en.txt', '{}'],
  ['locales/en.json', '[]'],
  ['locales/en.json', 'null'],
  ['locales/en.json', '{'],
  ['locales/en.json', '"text"'],
])('拒绝非法文案 %s %s', (path, text) => {
  const entries = new Map([
    ['server.mjs', server],
    [path, encode(text)],
  ])
  const m = { ...manifest, integrity: Object.fromEntries([...entries].map(([p, b]) => [p, sha256Hex(b)])) }
  expect(() => unpackPluginPackage(rawPackage(m, entries))).toThrow(expect.objectContaining({ code: 'invalid_locale' }))
})

test('拒绝包格式之外的文件', () => {
  const entries = new Map([
    ['server.mjs', server],
    ['extra.txt', encode('extra')],
  ])
  const m = { ...manifest, integrity: Object.fromEntries([...entries].map(([p, b]) => [p, sha256Hex(b)])) }
  expect(() => unpackPluginPackage(rawPackage(m, entries))).toThrow(
    expect.objectContaining({ code: 'unsupported_entry' }),
  )
})

test('文案按多个文件的原始字节合计，允许恰好 1 MiB，超过一个字节就拒绝', () => {
  const chinese = encode(JSON.stringify({ text: '中'.repeat(100_000) }))
  const entries = new Map([
    ['server.mjs', server],
    ['locales/zh-CN.json', chinese],
    ['locales/en.json', encode('{}' + ' '.repeat(MAX_LOCALE_BYTES - chinese.byteLength - 2))],
  ])
  const make = () =>
    rawPackage({ ...manifest, integrity: Object.fromEntries([...entries].map(([p, b]) => [p, sha256Hex(b)])) }, entries)
  expect(unpackPluginPackage(make()).messages['zh-CN']).toEqual({ text: '中'.repeat(100_000) })
  entries.set('locales/en.json', encode(new TextDecoder().decode(entries.get('locales/en.json')) + ' '))
  expect(() => unpackPluginPackage(make())).toThrow(
    expect.objectContaining({ code: 'locales_too_large', name: 'PluginPackageError' }),
  )
})

test('压缩大小、gzip 解压上限、文件数上限', () => {
  expect(() => unpackPluginPackage(new Uint8Array(MAX_PACKAGE_BYTES + 1))).toThrow(
    expect.objectContaining({ code: 'too_large' }),
  )
  expect(() => unpackPluginPackage(gzipSync(new Uint8Array(MAX_UNPACKED_BYTES + 1)))).toThrow(
    expect.objectContaining({ code: 'too_large' }),
  )
  const entries = Array.from({ length: 1001 }, (_, i) => ({ path: `f${i}`, bytes: new Uint8Array() }))
  expect(() => unpackPluginPackage(gzipSync(writeTar(entries)))).toThrow(
    expect.objectContaining({ code: 'too_many_files' }),
  )
})
