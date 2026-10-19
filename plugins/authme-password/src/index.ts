/**
 * AuthMe 密码（BS 的 authme-integration 的密码部分，ADR-0033）。
 *
 * 从装过 authme-integration 的 BS 旧站导入之后，有两种核心认不出的密码哈希：
 * - `$SHA$<盐>$<摘要>`：PWD_METHOD 是 SHA256 时 AuthMe 的格式，原样导入；
 * - `$authme$<算法>$<盐>$<摘要>`：PWD_METHOD 是 SALTED2MD5、SALTED2SHA512 时，每个用户的盐存在 users.salt 列，
 *   导入器把盐和摘要拼在一起（领域层的 formatAuthmeSalted）。
 * 算法照 AuthMe：sha256(sha256(密码) ‖ 盐)、md5(md5(密码) ‖ 盐)、sha512(密码 ‖ 盐)。
 * 用户用旧密码登录一次，核心就换成自己的算法，之后不再经过这个插件。不申请任何能力，也没有设置。
 * 旧插件"AuthMe 直接读写皮肤站的 users 表"那部分做不了：插件不能碰核心的表。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { definePlugin } from '@nextskin/plugin-sdk'

const digest = (algorithm: 'md5' | 'sha256' | 'sha512', value: string) =>
  createHash(algorithm).update(value, 'utf8').digest('hex')

/** AuthMe 和 BS 写的摘要都是小写十六进制；长度不对、有别的字符就不通过 */
function matches(expected: string, actual: string | undefined): boolean {
  if (actual === undefined || actual.length !== expected.length || !/^[0-9a-f]+$/.test(actual)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
}

/** 按哈希的格式核对；格式不认识就不通过 */
export function verifyAuthme(password: string, hash: string): boolean {
  const parts = hash.split('$')
  if (parts[0] !== '') return false
  if (parts[1] === 'SHA' && parts.length === 4) {
    // AuthMe 自己核对时不限制盐的长度，只要求有
    const salt = parts[2]
    return !!salt && matches(digest('sha256', digest('sha256', password) + salt), parts[3])
  }
  if (parts[1] === 'authme' && parts.length === 5) {
    const [, , algorithm, salt = ''] = parts
    if (!/^[0-9A-Za-z]{1,64}$/.test(salt)) return false
    if (algorithm === 'salted2md5') return matches(digest('md5', digest('md5', password) + salt), parts[4])
    if (algorithm === 'saltedsha512') return matches(digest('sha512', password + salt), parts[4])
  }
  return false
}

export default definePlugin({
  capabilities: [],
  providers: {
    passwordHasher: [
      {
        id: 'authme',
        label: 'hasher.authme',
        detect: { prefix: ['$SHA$', '$authme$'] },
        verify: ({ password, hash }) => Promise.resolve(verifyAuthme(password, hash)),
      },
    ],
  },
})
