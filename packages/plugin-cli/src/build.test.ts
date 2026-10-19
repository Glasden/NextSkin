import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { buildManifest, MAX_LOCALE_BYTES, sha256Hex, unpackPluginPackage } from '@nextskin/plugin-host'
import invitation from '../../../plugins/invitation-codes/src/official.ts'
import cdn from '../../../plugins/cdn-refresh/src/official.ts'
import { expect, test } from 'vitest'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))

test.each([
  ['invitation-codes', invitation],
  ['cdn-refresh', cdn],
] as const)(
  '构建官方插件 %s 并还原清单和文案',
  async (id, official) => {
    const temp = await mkdtemp(join(tmpdir(), 'nextskin build-'))
    try {
      const out = join(temp, 'plugin.tgz')
      // 构建会安装进程级模块钩子，因此在独立 Node 进程里验证真实 CLI。
      const result = await exec(process.execPath, [cli, 'build', resolve(repository, 'plugins', id), '--out', out], {
        timeout: 20_000,
      })
      const bytes = await readFile(out)
      const unpacked = unpackPluginPackage(bytes)
      const withoutPackageFields = (manifest: typeof unpacked.manifest) => {
        const { entry, integrity, ...rest } = manifest
        expect(entry).toBeDefined()
        expect(integrity).toBeDefined()
        return rest
      }
      expect(withoutPackageFields(unpacked.manifest)).toEqual(
        withoutPackageFields(buildManifest(official.definition, official.package)),
      )
      expect(unpacked.messages).toEqual(official.messages)
      expect(unpacked.manifest.entry).toEqual({ server: 'server.mjs' })
      expect(result.stdout).toContain(out)
      expect(result.stdout).toContain(sha256Hex(bytes))
      // 同一进程连续调用构建函数，覆盖钩子的幂等性和临时目录清理。
      const buildUrl = new URL('./build.ts', import.meta.url)
      const script = `
        import { buildPluginPackage } from ${JSON.stringify(buildUrl.href)};
        import assert from 'node:assert/strict';
        import { writeFile } from 'node:fs/promises';
        const dir = ${JSON.stringify(pathToFileURL(resolve(repository, 'plugins', id)).href)};
        const { fileURLToPath } = await import('node:url');
        const first = await buildPluginPackage({ dir: fileURLToPath(dir) });
        const second = await buildPluginPackage({ dir: fileURLToPath(dir) });
        assert.deepEqual(first.bytes, second.bytes);
        await writeFile(${JSON.stringify(out)}, first.bytes);
      `
      await exec(process.execPath, ['--input-type=module', '--eval', script], { timeout: 20_000 })
      expect(await readFile(out)).toEqual(bytes)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  },
  30_000,
)

test('默认目录、默认输出、内联动态导入和打包普通依赖', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'nextskin source-'))
  try {
    await mkdir(join(temp, 'src'))
    await mkdir(join(temp, 'node_modules', 'dependency'), { recursive: true })
    await writeFile(
      join(temp, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.2.3', nextskin: { id: 'test' } }),
    )
    await writeFile(
      join(temp, 'node_modules', 'dependency', 'package.json'),
      JSON.stringify({ name: 'dependency', main: 'index.js' }),
    )
    await writeFile(join(temp, 'node_modules', 'dependency', 'index.js'), 'module.exports = 42')
    await writeFile(join(temp, 'src', 'value.ts'), "import value from 'dependency'; export default value")
    await writeFile(
      join(temp, 'src', 'index.ts'),
      "const { default: value } = await import('./value.ts'); if (value !== 42) throw new Error('依赖没有打包'); export default { capabilities: [] }",
    )
    await exec(process.execPath, [cli, 'build'], { cwd: temp, timeout: 20_000 })
    const { manifest, files, messages } = unpackPluginPackage(await readFile(join(temp, 'dist', 'test-1.2.3.tgz')))
    expect(manifest.id).toBe('test')
    expect([...files.keys()]).toEqual(['manifest.json', 'server.mjs'])
    expect(messages).toEqual({})
    // 即便插件捕获了导入失败，也不能把未解析的依赖留到运行时。
    await writeFile(
      join(temp, 'src', 'index.ts'),
      "await import('missing-dependency').catch(() => {}); export default { capabilities: [] }",
    )
    await expect(exec(process.execPath, [cli, 'build'], { cwd: temp, timeout: 20_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('其他依赖要打包进 server.mjs') as unknown,
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 30_000)

test.each([[], ['build', '--bad'], ['build', '--out'], ['build', 'a', 'b'], ['build', '--out', 'a', '--out', 'b']])(
  '参数错误使用退出码 2：%j',
  async (...args) => {
    await expect(exec(process.execPath, [cli, ...args])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('用法：') as unknown,
    })
  },
)

test('构建自检拒绝原始文案总量超过 1 MiB 的插件', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'nextskin-locales-'))
  try {
    await mkdir(join(temp, 'src'))
    await mkdir(join(temp, 'locales'))
    await writeFile(
      join(temp, 'package.json'),
      JSON.stringify({ name: 'test', version: '1.0.0', nextskin: { id: 'test' } }),
    )
    await writeFile(join(temp, 'src', 'index.ts'), 'export default { capabilities: [] }')
    await writeFile(join(temp, 'locales', 'en.json'), '{}' + ' '.repeat(MAX_LOCALE_BYTES - 1))
    const script = `
      import assert from 'node:assert/strict';
      import { buildPluginPackage } from ${JSON.stringify(new URL('./build.ts', import.meta.url).href)};
      await assert.rejects(buildPluginPackage({ dir: ${JSON.stringify(temp)} }), { name: 'PluginPackageError', code: 'locales_too_large' });
    `
    await exec(process.execPath, ['--input-type=module', '--eval', script], { timeout: 20_000 })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 30_000)
