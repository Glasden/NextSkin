/**
 * 发布出去的两个包的元数据（ADR-0035）。打包本身由 `pnpm test:pack` 检查，它要联网，不进 pnpm check
 */
import { readFile } from 'node:fs/promises'
import { satisfies } from '@nextskin/plugin-host'
import { expect, test } from 'vitest'

const read = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')
const readJson = async <T>(path: string) => JSON.parse(await read(path)) as T

interface PackageJson {
  version: string
  dependencies?: Record<string, string>
}

test('两个包里的 LICENSE 和根目录的一致', async () => {
  const license = await read('LICENSE')
  expect(await read('packages/plugin-sdk/LICENSE')).toBe(license)
  expect(await read('packages/plugin-cli/LICENSE')).toBe(license)
})

test('两个包在 changesets 的 fixed 组里，版本号相同', async () => {
  const config = await readJson<{ fixed: string[][] }>('.changeset/config.json')
  expect(config.fixed).toContainEqual(['@nextskin/plugin-sdk', '@nextskin/plugin-cli'])
  const sdk = await readJson<PackageJson>('packages/plugin-sdk/package.json')
  const cli = await readJson<PackageJson>('packages/plugin-cli/package.json')
  expect(cli.version).toBe(sdk.version)
})

test.each(['zod', 'kysely'])(
  'SDK 对 %s 的依赖锁次版本，和 catalog 的次版本一致：插件运行时用的是核心的那一份',
  async (name) => {
    const catalog = /^catalog:\n((?: {2}.*\n)+)/m.exec(await read('pnpm-workspace.yaml'))?.[1] ?? ''
    const version = new RegExp(`^ {2}'?${name}'?: (\\S+)$`, 'm').exec(catalog)?.[1]
    expect(version).toBeDefined()
    const range = (await readJson<PackageJson>('packages/plugin-sdk/package.json')).dependencies?.[name]
    // 核心升了次版本，这里就会失败：SDK 跟着改依赖范围、发一个次版本（大版本见 ADR-0035）
    expect(range).toMatch(/^~\d+\.\d+\.\d+$/)
    expect(satisfies(version!, range!)).toBe(true)
  },
)
