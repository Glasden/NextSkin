import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { MANAGER_PROTOCOL, signDetached, signEntry, verifyEntry } from '../src/index.ts'
import type { SignedEntry } from '../src/index.ts'
import { releaseVersionPattern } from '../src/versions.ts'
import { releaseKeys, runCli, ScriptError } from './common.ts'

// 和 packages/launcher/release/nextskin.mjs、packages/launcher/src/main.ts 的下限一致；改下限时一起改。
const MIN_NODE = 24

export interface SignReleaseOptions {
  version: string
  zip: string
  sums: string
  out: string
}

export async function signRelease(
  options: SignReleaseOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignedEntry> {
  const { version, zip, sums, out } = options
  if (!releaseVersionPattern.test(version)) throw new ScriptError('版本号必须是正式版 X.Y.Z；预发布版本不进清单')
  const privateKey = env.NEXTSKIN_RELEASE_SIGNING_KEY
  const keyId = env.NEXTSKIN_RELEASE_KEY_ID
  if (!privateKey || !keyId) throw new ScriptError('缺少 NEXTSKIN_RELEASE_SIGNING_KEY 或 NEXTSKIN_RELEASE_KEY_ID')
  const keys = releaseKeys(env)
  const file = `nextskin-${version}.zip`
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(zip)) {
    const bytes = chunk as Buffer
    size += bytes.length
    if (size > 1024 ** 3) throw new ScriptError('ZIP 大小不能超过 1 GiB')
    hash.update(bytes)
  }
  const sha256 = hash.digest('hex')
  const sumsData = await readFile(sums)
  const matches = sumsData
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64}) [ *](.+)$/.exec(line))
    .filter((match) => match?.[2] === file)
  if (matches.length !== 1 || matches[0]![1] !== sha256)
    throw new ScriptError('SHA256SUMS 中的 ZIP 校验和不一致或条目不唯一')
  const signed = signEntry(
    {
      version,
      date: new Date().toISOString(),
      notes: `https://github.com/Glasden/NextSkin/releases/tag/v${version}`,
      file,
      sha256,
      size,
      minNode: MIN_NODE,
      managerProtocol: MANAGER_PROTOCOL,
    },
    privateKey,
    keyId,
  )
  if (!verifyEntry(signed, keys)) {
    throw new ScriptError('签名无法用内置公钥校验，请先发一个内置了新公钥的版本，并核对发布用的 key id 和私钥')
  }
  const signature = signDetached(sumsData, privateKey)
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'release-entry.json'), `${JSON.stringify(signed, null, 2)}\n`)
  await writeFile(join(out, 'SHA256SUMS.sig'), signature)
  return signed
}

export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      version: { type: 'string' },
      zip: { type: 'string' },
      sums: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const { version, zip, sums, out } = values
  if (!version || !zip || !sums || !out) {
    throw new ScriptError('用法：sign-release.ts --version <X.Y.Z> --zip <路径> --sums <路径> --out <目录>')
  }
  await signRelease({ version, zip, sums, out }, env)
}

if (import.meta.main) runCli(() => main())
