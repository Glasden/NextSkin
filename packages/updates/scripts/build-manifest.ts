import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { compareVersions, verifyEntry } from '../src/index.ts'
import type { ReleaseManifest, SignedEntry } from '../src/index.ts'
import { releaseKeys, runCli, ScriptError } from './common.ts'

export async function buildManifest(
  entries: string,
  out: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReleaseManifest> {
  const keys = releaseKeys(env)
  const releases: { signed: SignedEntry; version: string }[] = []
  const versions = new Set<string>()
  for (const file of (await readdir(entries)).filter((file) => file.endsWith('.json')).sort()) {
    let signed: unknown
    try {
      signed = JSON.parse(await readFile(join(entries, file), 'utf8'))
    } catch {
      throw new ScriptError('版本条目文件不是可读取的合法 JSON')
    }
    const entry = verifyEntry(signed, keys)
    if (!entry) throw new ScriptError('版本条目校验失败，请检查签名和内置公钥')
    // 发布端拒绝歧义，避免依赖文件名决定同一版本使用哪个条目。
    if (versions.has(entry.version)) throw new ScriptError('版本条目重复')
    versions.add(entry.version)
    releases.push({ signed: signed as SignedEntry, version: entry.version })
  }
  releases.sort((a, b) => compareVersions(b.version, a.version))
  const manifest: ReleaseManifest = { schema: 1, releases: releases.map(({ signed }) => signed) }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values } = parseArgs({ args, options: { entries: { type: 'string' }, out: { type: 'string' } } })
  if (!values.entries || !values.out) throw new ScriptError('用法：build-manifest.ts --entries <目录> --out <路径>')
  await buildManifest(values.entries, values.out, env)
}

if (import.meta.main) runCli(() => main())
