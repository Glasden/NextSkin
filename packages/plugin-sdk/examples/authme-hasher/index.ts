/**
 * 示例：识别 AuthMe 的 SHA256 密码格式（对应旧版 authme-integration 的密码部分）。
 *
 * 演示：Provider 扩展点。插件只负责"校验"，校验成功后核心会立刻改用自己的算法重新哈希，
 * 所以每个用户最多经过一次插件校验。
 * 旧插件"把用户同步进 AuthMe 的表"那部分需要访问外部数据库，属于另一类能力，不在这个示例里。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { definePlugin } from '@nextskin/plugin-sdk'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export default definePlugin({
  capabilities: [],
  providers: {
    passwordHasher: [
      {
        id: 'authme-sha256',
        label: 'hasher.authme',
        // 格式：$SHA$<salt>$<sha256(sha256(password) + salt)>
        detect: { prefix: ['$SHA$'] },
        async verify({ password, hash }) {
          const [, , salt, digest] = hash.split('$')
          if (!salt || !digest) return false
          const expected = Buffer.from(sha256(sha256(password) + salt), 'hex')
          const actual = Buffer.from(digest, 'hex')
          return expected.length === actual.length && timingSafeEqual(expected, actual)
        },
      },
    ],
  },
})
