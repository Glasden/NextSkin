import { hashPassword } from 'better-auth/crypto'
import * as hashWasm from 'hash-wasm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  formatLegacyDigest,
  isLegacyPasswordHash,
  legacyDigestAlgorithm,
  verifyLegacyPassword,
  type LegacyDigestAlgorithm,
} from './legacy-passwords.ts'

vi.mock('hash-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof hashWasm>()
  return {
    ...actual,
    argon2Verify: vi.fn(actual.argon2Verify),
    bcryptVerify: vi.fn(actual.bcryptVerify),
  }
})

// PHP 8.1 生成；Argon2 使用 m=1024,t=2,p=1，bcrypt 使用默认 cost=10。
const vectors = [
  {
    password: 'php-era-password',
    salt: 'bs-salt-中文',
    bcrypt: '$2y$10$rGpvsoGqqJj9Ahl6AnxY2uSd8VfK46pZU.MJKrw8/SYZwHn29jTB.',
    argon2i: '$argon2i$v=19$m=1024,t=2,p=1$dWp5eG9hSUdjOExxUlFFTQ$0+g6q+9g7eVJr+wgfOp/SCAOc0xZ58vxqL9Nqxb0NYA',
    argon2id: '$argon2id$v=19$m=1024,t=2,p=1$em9iTGkySXZGUGxZdmlOVw$rpkDb8218dM12NhVQLlXcVteowo/H/AaADnhtmtG5VE',
    md5: '25f98b07ce0a097df282108b5e6e64ad',
    salted2md5: '77e6d5924d477da6ac9b7e98f28fb8fc',
    sha256: 'f64d83ffe386ed0ef30fa057bf57edc54d1dd0b55d8ab2abc24d239665314598',
    salted2sha256: 'a99c25c7b8f53925aedf19fe78ccd0838ecb44f54baa455289c36798a80b07eb',
    sha512:
      '793b16263f3d5d05a18dd513cbc75f8de3e42fe375c97bfc3b7525be088954f534efcd518285393bc870bc6494df4b86f239b5a9430c91292b302e09f9213fbe',
    salted2sha512:
      'be118e5f43c764353339a08cd06056aba6e4f55db70c7e6d503f1b1294f79190db98cfc2eaaa6a0561ed7693b537cd64ed642485b8fdd7e9b4d0671e992a9d39',
    bcrypt_verify_truncated: true,
  },
  {
    password: '密码Pässword ✓',
    salt: 'bs-salt-中文',
    bcrypt: '$2y$10$FQbPDuDgf9AzC2J/oYF7yeN7gyy3wf2JsDh/n6UmlHfs2Nz4RNH7C',
    argon2i: '$argon2i$v=19$m=1024,t=2,p=1$eHZGbDVuRFRuaXBqMDNxcg$Wj5M6C40FRqyaBYVlIixIBYXufzFeEecdIchddLfwig',
    argon2id: '$argon2id$v=19$m=1024,t=2,p=1$SHM2R0pHYUV0QlJnNlpkcw$BYq01v7qbl5t2dzSs0bQseAm+oK198F0R2A3hB7j+WA',
    md5: 'fe3cc1149cb5a96ed42a5fdbc0c91b70',
    salted2md5: '7efc9cf1920d2a6357e09832a7036868',
    sha256: '50416be56396efe042cecabf5306b57c879eac8ae42cc0b7c2c0fe06bbb7e14b',
    salted2sha256: '16bee08994c7d9a2bd816d81fccdbeb294d120ec4519f9920acc65b7042f1d47',
    sha512:
      '56a79afac02818a82e04d3b567b0c6f47e177e06f98809ad4638e8b96904e7a191201105c97d81e35f521600335d03a070c17ab3762588d633f5e86d0903d87b',
    salted2sha512:
      '2e8a593c210b4df248cee64cf736ced22fde89eec7986fad44534870fda5d682cae01131d31d588ebf47adceeab29c79d2d916b49f8e4138d9851185485d3af5',
    bcrypt_verify_truncated: true,
  },
  {
    password: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaTAIL-IGNORED-BY-BCRYPT',
    salt: 'bs-salt-中文',
    bcrypt: '$2y$10$N5f3SIpn.u14igP0OPt4JebT4lCQ5NXGBHDXHrMVdPzsGpZxbcT32',
    argon2i: '$argon2i$v=19$m=1024,t=2,p=1$SGpMMGozam9COGNQWTR5RA$uuO1Zr4YlfcG6VSNwQgn/xhcsk1SJ4t372Wb8RmK0Sw',
    argon2id: '$argon2id$v=19$m=1024,t=2,p=1$SUhEeFFVS2ZvVXpQSjQ3MQ$8QtzvbFcRH7dtTT1XfwnGu8ndITBL2hKFgVZB5YFtQs',
    md5: '3b9b2978a86b211a8177b6d612c3a07a',
    salted2md5: 'dcadc3a5da9523304a4a1ab966613849',
    sha256: 'f2e5c339b86a2a5a9b130005882370652636cf9346952236600db5611e62e6e8',
    salted2sha256: '1bfd22b924c004549cbd34f85528bc274f9002c979fb615f057afe2b6312860c',
    sha512:
      '03317d9294edccc80daf901d46ec663caabffed6945862de369e67377bd739bb277de058ce6ee6630a77598b5d4e929e9d4c95568f5fb3d9bad515f53980c734',
    salted2sha512:
      '3512b5fb769107a161fcd454047464e9cff0550be0a9adc372c3194da841d68a86fc1c9a9626e9557ab85e06f98f6f010529c05ed9d8547f38e1ed69b180af1c',
    bcrypt_verify_truncated: true,
  },
]

const digestAlgorithms = [
  'md5',
  'salted2md5',
  'sha256',
  'salted2sha256',
  'sha512',
  'salted2sha512',
] as const satisfies readonly LegacyDigestAlgorithm[]
const selfDescribingAlgorithms = ['bcrypt', 'argon2i', 'argon2id'] as const
const first = vectors[0]!
const long = vectors[2]!

afterEach(() => vi.resetAllMocks())

for (const [index, vector] of vectors.entries()) {
  describe(`PHP 向量 ${index + 1}`, () => {
    for (const algorithm of digestAlgorithms) {
      test(`${algorithm}：正确密码通过，修改首字符失败，盐只影响带盐算法`, async () => {
        const hash = formatLegacyDigest(algorithm, vector[algorithm])
        expect(isLegacyPasswordHash(hash)).toBe(true)
        await expect(verifyLegacyPassword({ ...vector, hash })).resolves.toBe(true)
        await expect(verifyLegacyPassword({ ...vector, hash, password: 'X' + vector.password.slice(1) })).resolves.toBe(
          false,
        )
        await expect(verifyLegacyPassword({ ...vector, hash, salt: '错误的盐' })).resolves.toBe(
          !algorithm.startsWith('salted2'),
        )
      })
    }

    for (const algorithm of selfDescribingAlgorithms) {
      test(`${algorithm}：正确密码通过，修改首字符失败`, async () => {
        const hash = vector[algorithm]
        expect(isLegacyPasswordHash(hash)).toBe(true)
        await expect(verifyLegacyPassword({ ...vector, hash })).resolves.toBe(true)
        await expect(verifyLegacyPassword({ ...vector, hash, password: 'X' + vector.password.slice(1) })).resolves.toBe(
          false,
        )
      })
    }
  })
}

test('hash-wasm 会拒绝超过 72 字节的 bcrypt 输入；兼容层按 PHP 的方式截断', async () => {
  expect(Buffer.byteLength(long.password)).toBeGreaterThan(72)
  expect(long.bcrypt_verify_truncated).toBe(true)
  await expect(hashWasm.bcryptVerify({ hash: long.bcrypt, password: long.password })).rejects.toThrow()
  const truncated = Buffer.from(long.password).subarray(0, 72).toString('utf8')
  await expect(verifyLegacyPassword({ ...long, hash: long.bcrypt, password: truncated })).resolves.toBe(true)
  await expect(verifyLegacyPassword({ ...long, hash: long.bcrypt })).resolves.toBe(true)
})

test('bcrypt 在 UTF-8 字符中间截断时保留原始字节', async () => {
  const password = 'a'.repeat(71) + '密码'
  const hash = await hashWasm.bcrypt({
    password: Buffer.from(password).subarray(0, 72),
    salt: new Uint8Array(16).fill(1),
    costFactor: 4,
  })
  await expect(verifyLegacyPassword({ hash, password, salt: '' })).resolves.toBe(true)
  await expect(verifyLegacyPassword({ hash, password: 'X' + password.slice(1), salt: '' })).resolves.toBe(false)
})

test('bcrypt 的空密码按底层 C 字符串语义校验', async () => {
  const hash = await hashWasm.bcrypt({ password: new Uint8Array(1), salt: new Uint8Array(16), costFactor: 4 })
  await expect(verifyLegacyPassword({ hash, password: '', salt: '' })).resolves.toBe(true)
  await expect(verifyLegacyPassword({ hash, password: 'X', salt: '' })).resolves.toBe(false)
})

test.each(['2a', '2b', '2y'])('接受 bcrypt 的 $%s$ 前缀', async (prefix) => {
  const hash = first.bcrypt.replace('$2y$', `$${prefix}$`)
  expect(isLegacyPasswordHash(hash)).toBe(true)
  await expect(verifyLegacyPassword({ ...first, hash })).resolves.toBe(true)
})

test.each(digestAlgorithms)('格式化 %s 时转成小写，校验拒绝非约定的大写存储格式', async (algorithm) => {
  const digest = first[algorithm]
  expect(formatLegacyDigest(algorithm, digest.toUpperCase())).toBe(`$bs$${algorithm}$${digest}`)
  await expect(verifyLegacyPassword({ ...first, hash: `$bs$${algorithm}$${digest.toUpperCase()}` })).resolves.toBe(
    false,
  )
})

test.each(digestAlgorithms)('格式化 %s 时拒绝错误长度和非十六进制字符', (algorithm) => {
  const digest = first[algorithm]
  for (const invalid of ['', digest.slice(1), digest + '0', 'g' + digest.slice(1), digest.slice(1) + '\n']) {
    expect(() => formatLegacyDigest(algorithm, invalid)).toThrow('旧密码摘要格式不对')
  }
})

test('格式化时也拒绝运行时传入的未知算法', () => {
  expect(() => formatLegacyDigest('unknown' as LegacyDigestAlgorithm, first.md5)).toThrow('旧密码摘要格式不对')
})

test.each([
  ['BCRYPT', null],
  ['ARGON2I', null],
  ['PHP_PASSWORD_HASH', null],
  ['MD5', 'md5'],
  ['SALTED2MD5', 'salted2md5'],
  ['SHA256', 'sha256'],
  ['SALTED2SHA256', 'salted2sha256'],
  ['SHA512', 'sha512'],
  ['SALTED2SHA512', 'salted2sha512'],
])('映射 PWD_METHOD %s', (method, expected) => {
  expect(legacyDigestAlgorithm(method)).toBe(expected)
})

test('未知 PWD_METHOD 的错误列出全部支持值，不回显输入', () => {
  expect(() => legacyDigestAlgorithm('不应回显的值')).toThrow(
    '不支持此 PWD_METHOD；支持 BCRYPT、ARGON2I、PHP_PASSWORD_HASH、MD5、SALTED2MD5、SHA256、SALTED2SHA256、SHA512、SALTED2SHA512',
  )
})

const malformedHashes = [
  '',
  '不是哈希',
  first.md5,
  '$bs$',
  `$bs$unknown$${first.md5}`,
  `$bs$toString$${first.md5}`,
  `$bs$MD5$${first.md5}`,
  `$bs$md5$${first.md5.slice(1)}`,
  `$bs$md5$g${first.md5.slice(1)}`,
  `$bs$md5$${first.md5}$额外字段`,
  `$bs$md5$${first.md5.slice(1)}\n`,
  `$bs$md5$${'0'.repeat(32)}`,
  first.bcrypt.slice(0, -1),
  first.bcrypt.replace('$10$', '$03$'),
  first.bcrypt.replace('$10$', '$32$'),
  first.bcrypt.replace('$2y$', '$2x$'),
  first.bcrypt.slice(0, -1) + '!',
  first.argon2i.slice(0, -1),
  first.argon2id.slice(0, -1) + '!',
  first.argon2i + '\n',
  first.argon2i.replace('$v=19$', '$v=16$'),
  first.argon2i.replace('$argon2i$', '$argon2d$'),
  first.argon2i.replace('m=1024,t=2,p=1', 'm=1024,m=2,p=1'),
  first.argon2i.replace('m=1024,t=2,p=1', 'm=1024,t=2'),
  first.argon2i.replace('m=1024', 'm=0'),
  first.argon2i.replace('t=2', 't=0'),
  first.argon2i.replace('p=1', 'p=0'),
  first.argon2i.replace('m=1024', 'm=7'),
  first.argon2i.replace('m=1024', 'm=-1'),
  first.argon2i.replace('m=1024', 'm=1e3'),
  first.argon2i.replace('UlFFTQ$', 'UlFFTR$'),
  first.argon2i.replace('$dWp5eG9hSUdjOExxUlFFTQ$', '$A$'),
]

test.each(malformedHashes.map((hash, index) => ({ hash, index })))(
  '坏哈希 $index 返回 false，不抛错',
  async ({ hash }) => {
    await expect(verifyLegacyPassword({ ...first, hash })).resolves.toBe(false)
  },
)

test.each(['argon2i', 'argon2id'] as const)('%s 的异常参数在调用 WASM 前被拒绝', async (algorithm) => {
  const verify = vi.mocked(hashWasm.argon2Verify).mockResolvedValue(false)
  for (const parameters of [
    'm=262145,t=2,p=1',
    'm=1024,t=17,p=1',
    'm=1024,t=2,p=9',
    'm=99999999999999999999,t=2,p=1',
    'm=1024,t=99999999999999999999,p=1',
    'm=1024,t=2,p=99999999999999999999',
    'm=32,t=2,p=8',
  ]) {
    const hash = first[algorithm].replace('m=1024,t=2,p=1', parameters)
    await expect(verifyLegacyPassword({ ...first, hash })).resolves.toBe(false)
  }
  expect(verify).not.toHaveBeenCalled()
})

test('Argon2 参数上限本身仍可进入校验器，不在测试中实际分配大内存', async () => {
  const verify = vi.mocked(hashWasm.argon2Verify).mockResolvedValue(true)
  const hash = first.argon2i.replace('m=1024,t=2,p=1', 'm=262144,t=16,p=8')
  await expect(verifyLegacyPassword({ ...first, hash })).resolves.toBe(true)
  expect(verify).toHaveBeenCalledWith({ hash, password: first.password })
})

test('WASM 校验器抛错时返回 false', async () => {
  vi.mocked(hashWasm.argon2Verify).mockRejectedValue(new Error('底层校验失败'))
  await expect(verifyLegacyPassword({ ...first, hash: first.argon2i })).resolves.toBe(false)
  vi.mocked(hashWasm.bcryptVerify).mockRejectedValue(new Error('底层校验失败'))
  await expect(verifyLegacyPassword({ ...first, hash: first.bcrypt })).resolves.toBe(false)
})

test('Better Auth 的 scrypt 哈希不是旧哈希，兼容层返回 false', async () => {
  const hash = await hashPassword('用于测试的新密码')
  expect(hash).toMatch(/^[a-f0-9]+:[a-f0-9]+$/)
  expect(isLegacyPasswordHash(hash)).toBe(false)
  await expect(verifyLegacyPassword({ ...first, hash })).resolves.toBe(false)
})

test.each(['$bs$损坏', '$2a$', '$2b$', '$2y$', '$argon2i$', '$argon2id$'])(
  '按旧格式标识识别损坏的数据，留给校验器拒绝',
  (hash) => expect(isLegacyPasswordHash(hash)).toBe(true),
)

test.each(['', 'abc:def', first.md5, '$2x$', '$argon2d$', '$unknown$'])('不识别未支持的格式', (hash) =>
  expect(isLegacyPasswordHash(hash)).toBe(false),
)
