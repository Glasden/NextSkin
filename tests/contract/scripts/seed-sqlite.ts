// 把契约用例的固定数据写进一个新的 NextSkin 数据目录（SQLite + 本地材质），供 e2e 经 Next 回放：
//   NEXTSKIN_SECRET=… node tests/contract/scripts/seed-sqlite.ts <数据目录>
// 签名公钥写到 <数据目录>/signing-public-key.pem，回放时用它验证签名。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createDatabase, type CoreDatabase } from '@nextskin/db'
import { generateSigningKey, seedWorld } from '../src/seed.ts'

const directory = process.argv[2]
const secretKey = process.env.NEXTSKIN_SECRET
if (!directory || !secretKey) throw new Error('用法：NEXTSKIN_SECRET=… node scripts/seed-sqlite.ts <数据目录>')
const dataDirectory = resolve(directory)
mkdirSync(dataDirectory, { recursive: true })
const keys = generateSigningKey()
const db = createDatabase<CoreDatabase>({ dialect: 'sqlite', file: join(dataDirectory, 'nextskin.sqlite') })
try {
  await seedWorld(db, { textureDirectory: join(dataDirectory, 'textures'), secretKey, signingKey: keys.privateKey })
} finally {
  await db.destroy()
}
writeFileSync(join(dataDirectory, 'signing-public-key.pem'), keys.publicKey)
