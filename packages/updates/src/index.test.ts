import { spawnSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANAGER_PROTOCOL,
  MANIFEST_URL,
  ManifestError,
  RELEASE_KEYS,
  compareVersions,
  downloadUrls,
  newerReleases,
  readManifest,
  signDetached,
  signEntry,
  verifyDetached,
  verifyEntry,
} from './index.ts'
import type { ReleaseEntry, SignedEntry } from './index.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const other = generateKeyPairSync('ed25519')
const keys = { 'test-key': publicKey, other: other.publicKey.export({ type: 'spki', format: 'pem' }).toString() }

function release(version = '1.2.3'): ReleaseEntry {
  return {
    version,
    date: '2026-10-23T12:34:56.123Z',
    notes: `https://github.com/Glasden/NextSkin/releases/tag/v${version}`,
    file: `nextskin-${version}.zip`,
    sha256: 'ab'.repeat(32),
    size: 1024,
    minNode: 24,
    managerProtocol: MANAGER_PROTOCOL,
  }
}

// 绕过签名端的字段校验，模拟外部签名者生成的非法条目。
function signedRaw(value: unknown): SignedEntry {
  const entry = JSON.stringify(value)
  return { entry, key: 'test-key', signature: sign(null, Buffer.from(entry), privateKey).toString('base64') }
}

describe('条目签名与校验', () => {
  it('签的是原始 UTF-8 文本，条目可以往返', () => {
    const entry = release()
    entry.notes += '?说明=发布'
    const signed = signEntry(entry, privateKey, 'test-key')
    expect(verifyEntry(signed, keys)).toEqual(entry)
    expect(verifyDetached(Buffer.from(signed.entry), Buffer.from(signed.signature, 'base64'), publicKey)).toBe(true)
    expect(verifyEntry({ ...signed, entry: signed.entry + ' ' }, keys)).toBeNull()
    expect(verifyEntry({ ...signed, entry: signed.entry.replace('1.2.3', '9.9.9') }, keys)).toBeNull()
  })

  it('拒绝换 key id、未知 key id 和非法 key id', () => {
    const signed = signEntry(release(), privateKey, 'test-key')
    for (const key of ['other', 'unknown', '', 'UPPER', 'a'.repeat(33), '../key', 'constructor', 'test-key\n']) {
      expect(verifyEntry({ ...signed, key }, keys)).toBeNull()
    }
    expect(verifyEntry(signed, { 'test-key': '无效 PEM' })).toBeNull()
    expect(verifyEntry(signed)).toBeNull()
  })

  it('拒绝损坏、不规范或错误长度的 base64 签名', () => {
    const signed = signEntry(release(), privateKey, 'test-key')
    for (const signature of [
      '',
      '*'.repeat(88),
      'A'.repeat(88),
      signed.signature.slice(0, -2),
      signed.signature + '\n',
      Buffer.alloc(63).toString('base64'),
      Buffer.alloc(65).toString('base64'),
      'A'.repeat(85) + 'B==',
      Buffer.alloc(64).toString('base64'),
    ]) {
      expect(verifyEntry({ ...signed, signature }, keys)).toBeNull()
    }
  })

  it.each([null, [], {}, 'text', { entry: 1, key: 'test-key', signature: '' }])('拒绝非法包装结构：%j', (value) => {
    expect(verifyEntry(value, keys)).toBeNull()
  })

  it('拒绝包装多字段和签名有效但 JSON 非法的条目', () => {
    expect(verifyEntry({ ...signedRaw(release()), extra: true }, keys)).toBeNull()
    const entry = '{'
    expect(
      verifyEntry(
        { entry, key: 'test-key', signature: signDetached(Buffer.from(entry), privateKey).toString('base64') },
        keys,
      ),
    ).toBeNull()
  })

  it('每一个字段都不能缺少、类型不能出错，也不能添加字段', () => {
    for (const field of Object.keys(release())) {
      const entry: Record<string, unknown> = { ...release() }
      delete entry[field]
      expect(verifyEntry(signedRaw(entry), keys)).toBeNull()
      expect(verifyEntry(signedRaw({ ...release(), [field]: null }), keys)).toBeNull()
      expect(
        verifyEntry(
          signedRaw({ ...release(), [field]: typeof release()[field as keyof ReleaseEntry] === 'string' ? 1 : '1' }),
          keys,
        ),
      ).toBeNull()
    }
    expect(verifyEntry(signedRaw({ ...release(), extra: true }), keys)).toBeNull()
    for (const value of [null, [], 'text']) expect(verifyEntry(signedRaw(value), keys)).toBeNull()
  })

  it.each([
    { version: 'v1.2.3' },
    { version: '1.2' },
    { version: '01.2.3' },
    { version: '1.2.3-rc.1' },
    { version: '1.2.3+build' },
    { version: '1.2.3\n' },
    { file: '../nextskin-1.2.3.zip' },
    { file: 'nextskin-1.2.4.zip' },
    { sha256: 'AB'.repeat(32) },
    { sha256: 'a'.repeat(63) },
    { sha256: 'g'.repeat(64) },
    { sha256: 'a'.repeat(64) + '\n' },
    { size: 0 },
    { size: -1 },
    { size: 1.5 },
    { size: 1024 ** 3 + 1 },
    { minNode: 0 },
    { minNode: -1 },
    { minNode: 1.1 },
    { minNode: Number.MAX_SAFE_INTEGER + 1 },
    { managerProtocol: 0 },
    { managerProtocol: -1 },
    { managerProtocol: 1.1 },
    { notes: 'http://example.com' },
    { notes: 'https://' },
    { date: 'yesterday' },
    { date: '2026-10-23' },
    { date: '2026-02-30T00:00:00Z' },
    { date: '2026-10-23T25:00:00Z' },
    { date: '2026-10-23T12:34:56+08:00' },
    { date: '2026-10-23T12:34:56Z\n' },
  ])('拒绝字段值：%j', (change) => {
    expect(verifyEntry(signedRaw({ ...release(), ...change }), keys)).toBeNull()
  })

  it('接受合法边界和 UTC ISO 时间', () => {
    for (const date of ['2024-02-29T00:00:00Z', '2026-10-23T12:34:56.1Z', '2026-10-23T12:34:56.123Z']) {
      const entry = { ...release('0.0.0'), size: 1024 ** 3, date }
      expect(verifyEntry(signedRaw(entry), keys)).toEqual(entry)
    }
  })

  it('签名端也拒绝非法输入和非 ed25519 密钥', () => {
    expect(() => signEntry({ ...release(), size: 0 }, privateKey, 'test-key')).toThrow()
    expect(() => signEntry(release(), privateKey, 'BAD')).toThrow()
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    expect(() =>
      signDetached(Buffer.from('data'), ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    ).toThrow('ed25519')
    expect(
      verifyDetached(
        Buffer.from('data'),
        Buffer.alloc(64),
        ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ),
    ).toBe(false)
  })
})

describe('版本比较', () => {
  it('遵循正式版、预发布数字和字符串标识的 semver 顺序', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.2',
      '1.0.0-rc.10',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
      '10.0.0',
    ]
    ordered.forEach((left, i) =>
      ordered.forEach((right, j) => {
        expect(Math.sign(compareVersions(left, right))).toBe(Math.sign(i - j))
      }),
    )
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0)
    expect(compareVersions('1.0.0-99999999999999999999', '1.0.0-99999999999999999998')).toBe(1)
    expect(compareVersions('99999999999999999999.0.0', '99999999999999999998.0.0')).toBe(1)
  })

  it.each([
    '',
    '1',
    '1.2',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.0.0-01',
    '1.0.0-',
    '1.0.0-a..b',
    '1.0.0+build..x',
    '1.0.0\n',
    ' 1.0.0',
    '1.0.0-测试',
  ])('拒绝非法 semver：%j', (version) => {
    expect(() => compareVersions(version, '1.0.0')).toThrow()
    expect(() => compareVersions('1.0.0', version)).toThrow()
  })

  it('返回比当前版本新的正式版，倒序且不修改输入', () => {
    const releases = [release('1.0.0'), release('2.0.0'), release('1.1.0'), release('0.9.0'), release('3.0.0-rc.1')]
    const original = [...releases]
    expect(newerReleases('1.0.0-rc.10', releases).map((entry) => entry.version)).toEqual(['2.0.0', '1.1.0', '1.0.0'])
    expect(newerReleases('1.0.0', releases).map((entry) => entry.version)).toEqual(['2.0.0', '1.1.0'])
    expect(newerReleases('2.0.0', releases)).toEqual([])
    expect(releases).toEqual(original)
    expect(() => newerReleases('bad', [])).toThrow()
  })
})

describe('清单与下载地址', () => {
  it('坏条目和重复版本计入 rejected，保留第一个合法条目', () => {
    const first = signEntry(release(), privateKey, 'test-key')
    const duplicate = signEntry({ ...release(), size: 2048 }, privateKey, 'test-key')
    const bad = { ...first, signature: '' }
    const body = { schema: 1, releases: [bad, first, duplicate, signedRaw(release('2.0.0')), null] }
    const expected = { releases: [release(), release('2.0.0')], rejected: 3 }
    expect(readManifest(body, keys)).toEqual(expected)
    expect(readManifest(JSON.stringify(body), keys)).toEqual(expected)
    expect(readManifest({ schema: 1, releases: [first] })).toEqual({ releases: [], rejected: 1 })
    expect(readManifest({ schema: 1, releases: [] })).toEqual({ releases: [], rejected: 0 })
  })

  it.each([
    null,
    [],
    {},
    '{',
    { schema: 2, releases: [] },
    { schema: 1, releases: {} },
    { schema: 1, releases: [], extra: true },
  ])('非法清单抛 ManifestError：%j', (body) => {
    expect(() => readManifest(body, keys)).toThrow(ManifestError)
  })

  it('下载顺序是 dl 然后 GitHub', () => {
    expect(MANIFEST_URL).toBe('https://dl.nextskin.org/releases/v1.json')
    expect(downloadUrls(release())).toEqual([
      'https://dl.nextskin.org/releases/1.2.3/nextskin-1.2.3.zip',
      'https://github.com/Glasden/NextSkin/releases/download/v1.2.3/nextskin-1.2.3.zip',
    ])
  })
})

describe('分离签名', () => {
  it('产生 64 字节原始签名，拒绝篡改和无效公钥', () => {
    const data = Buffer.from('SHA256SUMS\n')
    const signature = signDetached(data, privateKey)
    expect(signature).toHaveLength(64)
    expect(verifyDetached(data, signature, publicKey)).toBe(true)
    expect(verifyDetached(Buffer.from('changed'), signature, publicKey)).toBe(false)
    expect(verifyDetached(data, signature.subarray(1), publicKey)).toBe(false)
    expect(verifyDetached(data, signature, '无效 PEM')).toBe(false)
    expect(verifyDetached(data, signature, keys.other)).toBe(false)
  })

  it('OpenSSL 能直接校验原始签名', (context) => {
    const help = spawnSync('openssl', ['pkeyutl', '-help'], { encoding: 'utf8' })
    if (help.error || !`${help.stdout}${help.stderr}`.includes('-rawin')) {
      context.skip('系统没有 openssl 或不支持 -rawin')
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'nextskin-updates-openssl-'))
    try {
      const data = Buffer.from('a'.repeat(64) + '  nextskin-1.2.3.zip\n')
      writeFileSync(join(dir, 'pub.pem'), publicKey)
      writeFileSync(join(dir, 'data'), data)
      writeFileSync(join(dir, 'sig'), signDetached(data, privateKey))
      const result = spawnSync(
        'openssl',
        [
          'pkeyutl',
          '-verify',
          '-pubin',
          '-inkey',
          join(dir, 'pub.pem'),
          '-rawin',
          '-in',
          join(dir, 'data'),
          '-sigfile',
          join(dir, 'sig'),
        ],
        { encoding: 'utf8' },
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('内置公钥', () => {
  it('是 ed25519 公钥，和文档站给手动校验用的公钥文件一一对应', () => {
    const dir = join(import.meta.dirname, '../../../apps/docs/public/release-keys')
    const files = Object.fromEntries(
      readdirSync(dir).map((file) => [file.replace(/\.pem$/, ''), readFileSync(join(dir, file), 'utf8')]),
    )
    expect(files).toEqual(RELEASE_KEYS)
    for (const pem of Object.values(RELEASE_KEYS)) expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519')
  })
})
