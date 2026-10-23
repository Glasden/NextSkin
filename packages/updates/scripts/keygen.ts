import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { keyIdPattern } from '../src/versions.ts'
import { runCli, ScriptError } from './common.ts'

export function generateReleaseKey(
  output: string,
  keyId = new Date().toISOString().slice(0, 7),
): { keyId: string; publicKey: string } {
  if (!keyIdPattern.test(keyId)) throw new ScriptError('key id 只允许 1–32 位小写字母、数字和连字符')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  try {
    writeFileSync(output, privateKey, { flag: 'wx', mode: 0o600 })
  } catch {
    throw new ScriptError('无法创建私钥文件：文件已存在或目录不可写')
  }
  return { keyId, publicKey }
}

export function main(args = process.argv.slice(2)): void {
  const { values, positionals } = parseArgs({
    args,
    options: { 'key-id': { type: 'string' } },
    allowPositionals: true,
  })
  if (positionals.length !== 1) throw new ScriptError('用法：keygen.ts <私钥输出路径> [--key-id <id>]')
  const result = generateReleaseKey(positionals[0]!, values['key-id'])
  console.log(`key id: ${result.keyId}\n${result.publicKey}`)
  console.log('请把公钥填进 RELEASE_KEYS，把私钥存进 environment release 的 secret NEXTSKIN_RELEASE_SIGNING_KEY。')
}

if (import.meta.main) runCli(() => main())
