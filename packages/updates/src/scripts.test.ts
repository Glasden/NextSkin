import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildManifest, main as manifestMain } from '../scripts/build-manifest.ts'
import { releaseKeys } from '../scripts/common.ts'
import { generateReleaseKey } from '../scripts/keygen.ts'
import { main as signMain, signRelease } from '../scripts/sign-release.ts'
import { MANAGER_PROTOCOL, readManifest, signEntry, verifyDetached, verifyEntry } from './index.ts'
import type { ReleaseEntry } from './index.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const keys = { 'test-key': publicKey }
const env: NodeJS.ProcessEnv = {
  NEXTSKIN_RELEASE_SIGNING_KEY: privateKey,
  NEXTSKIN_RELEASE_KEY_ID: 'test-key',
  NEXTSKIN_RELEASE_KEYS_JSON: JSON.stringify(keys),
}
let dir: string
let zip: string
let sums: string
let out: string
const zipData = Buffer.from('测试用 ZIP 字节，不需要解压')
const sha256 = createHash('sha256').update(zipData).digest('hex')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nextskin-updates-scripts-'))
  zip = join(dir, 'input.zip')
  sums = join(dir, 'SHA256SUMS')
  out = join(dir, 'out')
  writeFileSync(zip, zipData)
  writeFileSync(sums, `${sha256}  nextskin-1.2.3.zip\n`)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entry(version = '1.2.3'): ReleaseEntry {
  return {
    version,
    date: '2026-10-23T00:00:00.000Z',
    notes: `https://github.com/Glasden/NextSkin/releases/tag/v${version}`,
    file: `nextskin-${version}.zip`,
    sha256,
    size: zipData.length,
    minNode: 24,
    managerProtocol: MANAGER_PROTOCOL,
  }
}

function cli(script: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(import.meta.dirname, '../scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, ...overrides },
  })
}

describe('keygen', () => {
  it('生成 PKCS#8 私钥和 SPKI 公钥，文件不能覆盖，POSIX 权限为 0600', () => {
    const path = join(dir, 'private.pem')
    const generated = generateReleaseKey(path, '2026-10')
    const pem = readFileSync(path, 'utf8')
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----')
    expect(generated.publicKey).toContain('-----BEGIN PUBLIC KEY-----')
    expect(verifyEntry(signEntry(entry(), pem, generated.keyId), { [generated.keyId]: generated.publicKey })).toEqual(
      entry(),
    )
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => generateReleaseKey(path)).toThrow('文件已存在')
    expect(readFileSync(path, 'utf8')).toBe(pem)
    expect(() => generateReleaseKey(join(dir, 'bad.pem'), 'BAD')).toThrow('key id')
    expect(existsSync(join(dir, 'bad.pem'))).toBe(false)
  })

  it('Node 直接运行，默认 key id 为 UTC 年月，只打印公钥和存放提示', () => {
    const before = new Date().toISOString().slice(0, 7)
    const result = cli('keygen.ts', [join(dir, 'generated.pem')])
    expect(result.status, result.stderr).toBe(0)
    expect([before, new Date().toISOString().slice(0, 7)].some((id) => result.stdout.includes(`key id: ${id}`))).toBe(
      true,
    )
    expect(result.stdout).toContain('-----BEGIN PUBLIC KEY-----')
    expect(result.stdout).toContain('RELEASE_KEYS')
    expect(result.stdout).toContain('NEXTSKIN_RELEASE_SIGNING_KEY')
    expect(result.stdout + result.stderr).not.toContain('-----BEGIN PRIVATE KEY-----')
    const explicit = cli('keygen.ts', [join(dir, 'explicit.pem'), '--key-id', 'custom-key'])
    expect(explicit.status).toBe(0)
    expect(explicit.stdout).toContain('key id: custom-key')
    expect(cli('keygen.ts', [join(dir, 'explicit.pem')]).status).toBe(1)
  })
})

describe('sign-release', () => {
  it('核对 ZIP 后写出签名条目和可校验的 SHA256SUMS 分离签名', async () => {
    const before = Date.now()
    const signed = await signRelease({ version: '1.2.3', zip, sums, out }, env)
    const release = verifyEntry(signed, keys)!
    expect(release).toEqual({ ...entry(), date: release.date })
    expect(Date.parse(release.date)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(release.date)).toBeLessThanOrEqual(Date.now())
    const json = readFileSync(join(out, 'release-entry.json'), 'utf8')
    expect(json.endsWith('\n')).toBe(true)
    expect(JSON.parse(json)).toEqual(signed)
    const signature = readFileSync(join(out, 'SHA256SUMS.sig'))
    expect(signature).toHaveLength(64)
    expect(verifyDetached(readFileSync(sums), signature, publicKey)).toBe(true)
  })

  it.each([
    `${'0'.repeat(64)}  nextskin-1.2.3.zip\n`,
    `${sha256}  nextskin-9.9.9.zip\n`,
    `${sha256}  nextskin-1.2.3.zip\n${sha256}  nextskin-1.2.3.zip\n`,
  ])('拒绝不一致、缺少和重复的校验和', async (body) => {
    writeFileSync(sums, body)
    await expect(signRelease({ version: '1.2.3', zip, sums, out }, env)).rejects.toThrow('SHA256SUMS')
    expect(existsSync(out)).toBe(false)
  })

  it('接受 sha256sum 二进制标记和 CRLF，并签署原始字节', async () => {
    writeFileSync(sums, `${sha256} *nextskin-1.2.3.zip\r\n`)
    await signRelease({ version: '1.2.3', zip, sums, out }, env)
    expect(verifyDetached(readFileSync(sums), readFileSync(join(out, 'SHA256SUMS.sig')), publicKey)).toBe(true)
  })

  it.each(['1.2.3-rc.1', 'v1.2.3', '01.2.3', '1.2.3+build', '1.2.3\n'])('拒绝非正式版：%j', async (version) => {
    await expect(signRelease({ version, zip, sums, out }, env)).rejects.toThrow('正式版')
    expect(existsSync(out)).toBe(false)
  })

  it('私钥和公钥不匹配、未知 key id、内置公钥里没有的 key id 都在写文件前失败', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    for (const override of [
      { NEXTSKIN_RELEASE_KEYS_JSON: JSON.stringify({ 'test-key': other }) },
      { NEXTSKIN_RELEASE_KEY_ID: 'unknown' },
      { NEXTSKIN_RELEASE_KEYS_JSON: undefined },
    ]) {
      await expect(signRelease({ version: '1.2.3', zip, sums, out }, { ...env, ...override })).rejects.toThrow(
        '先发一个内置了新公钥的版本',
      )
      expect(existsSync(out)).toBe(false)
    }
  })

  it('缺少私钥或 key id 时拒绝', async () => {
    for (const field of ['NEXTSKIN_RELEASE_SIGNING_KEY', 'NEXTSKIN_RELEASE_KEY_ID']) {
      await expect(signRelease({ version: '1.2.3', zip, sums, out }, { ...env, [field]: '' })).rejects.toThrow('缺少')
    }
  })

  it('Node 命令行能完成签名，失败返回 1 且不泄露私钥输入', () => {
    const args = ['--version', '1.2.3', '--zip', zip, '--sums', sums, '--out', out]
    const result = cli('sign-release.ts', args)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(out, 'release-entry.json'))).toBe(true)
    for (const overrides of [
      { NEXTSKIN_RELEASE_SIGNING_KEY: '' },
      { NEXTSKIN_RELEASE_KEY_ID: '' },
      { NEXTSKIN_RELEASE_SIGNING_KEY: 'secret-input-must-not-be-logged' },
      { NEXTSKIN_RELEASE_KEYS_JSON: '{secret-input-must-not-be-logged' },
    ]) {
      const failed = cli('sign-release.ts', args, overrides)
      expect(failed.status).toBe(1)
      expect(failed.stderr).not.toContain('secret-input-must-not-be-logged')
      expect(failed.stderr).not.toContain(privateKey)
    }
  })
})

describe('build-manifest', () => {
  it('校验所有条目，按语义版本从新到旧排序，不重新序列化签名文本', async () => {
    const entries = join(dir, 'entries')
    mkdirSync(entries)
    for (const version of ['1.9.0', '2.0.0', '1.10.0']) {
      writeFileSync(join(entries, `${version}.json`), JSON.stringify(signEntry(entry(version), privateKey, 'test-key')))
    }
    writeFileSync(join(entries, 'ignored.txt'), '不是条目')
    const output = join(out, 'v1.json')
    const manifest = await buildManifest(entries, output, env)
    expect(readManifest(manifest, keys).releases.map((entry) => entry.version)).toEqual(['2.0.0', '1.10.0', '1.9.0'])
    expect(readFileSync(output, 'utf8').endsWith('\n')).toBe(true)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(manifest)
    const result = cli('build-manifest.ts', ['--entries', entries, '--out', join(out, 'cli.json')])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(out, 'cli.json'), 'utf8')).toBe(readFileSync(output, 'utf8'))
  })

  it.each(['{', JSON.stringify({ entry: '{}', key: 'unknown', signature: '' })])(
    '任一条目损坏就拒绝写清单',
    async (body) => {
      const entries = join(dir, 'entries')
      mkdirSync(entries)
      writeFileSync(join(entries, 'bad.json'), body)
      await expect(buildManifest(entries, join(out, 'v1.json'), env)).rejects.toThrow()
      expect(existsSync(out)).toBe(false)
      expect(cli('build-manifest.ts', ['--entries', entries, '--out', join(out, 'v1.json')]).status).toBe(1)
    },
  )

  it('重复版本和未知公钥也拒绝', async () => {
    const entries = join(dir, 'entries')
    mkdirSync(entries)
    const signed = signEntry(entry(), privateKey, 'test-key')
    writeFileSync(join(entries, 'a.json'), JSON.stringify(signed))
    await expect(buildManifest(entries, join(out, 'v1.json'), {})).rejects.toThrow('校验失败')
    writeFileSync(join(entries, 'b.json'), JSON.stringify(signed))
    await expect(buildManifest(entries, join(out, 'v1.json'), env)).rejects.toThrow('重复')
    expect(existsSync(out)).toBe(false)
  })

  it('空目录生成空清单', async () => {
    const entries = join(dir, 'entries')
    mkdirSync(entries)
    expect(await buildManifest(entries, join(out, 'v1.json'), env)).toEqual({ schema: 1, releases: [] })
  })
})

it('脚本参数和公钥覆盖配置严格校验', async () => {
  for (const value of ['{', 'null', '[]', '1', '{"BAD":"pem"}', '{"key":1}']) {
    expect(() => releaseKeys({ NEXTSKIN_RELEASE_KEYS_JSON: value })).toThrow('NEXTSKIN_RELEASE_KEYS_JSON')
  }
  await expect(signMain([], env)).rejects.toThrow('用法')
  await expect(manifestMain([], env)).rejects.toThrow('用法')
  for (const script of ['keygen.ts', 'sign-release.ts', 'build-manifest.ts']) {
    expect(cli(script, []).status).toBe(1)
    expect(cli(script, ['--unknown']).status).toBe(1)
  }
})
