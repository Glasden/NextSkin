import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import sdkPackage from '@nextskin/plugin-sdk/package.json' with { type: 'json' }
import {
  buildManifest,
  MAX_LOCALE_BYTES,
  PLUGIN_API_VERSION,
  pluginApiRange,
  sha256Hex,
  unpackPluginPackage,
} from '@nextskin/plugin-host'
import invitation from '../../../plugins/invitation-codes/src/official.ts'
import cdn from '../../../plugins/cdn-refresh/src/official.ts'
import share from '../../../plugins/share-registration-link/src/official.ts'
import colorThemes from '../../../plugins/color-themes/src/official.ts'
import { expect, test } from 'vitest'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))

/** 像插件作者的项目一样，把 SDK 装进临时插件项目的 node_modules：构建命令按它算 `api` */
async function installSdk(dir: string) {
  await mkdir(join(dir, 'node_modules', '@nextskin'), { recursive: true })
  await symlink(
    join(repository, 'packages', 'plugin-sdk'),
    join(dir, 'node_modules', '@nextskin', 'plugin-sdk'),
    'junction',
  )
}

test.each([
  ['invitation-codes', invitation],
  ['cdn-refresh', cdn],
  ['share-registration-link', share],
  ['color-themes', colorThemes],
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
      const withoutPackageFields = (manifest: ReturnType<typeof buildManifest>) => {
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
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
  30_000,
)

test('默认目录、默认输出、内联动态导入和打包普通依赖', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'nextskin source-'))
  try {
    await mkdir(join(temp, 'src'))
    await mkdir(join(temp, 'node_modules', 'dependency'), { recursive: true })
    await installSdk(temp)
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
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
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
    await installSdk(temp)
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
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)

test('manifest 的 api 按插件项目里装的 SDK 算', async () => {
  const dir = await project()
  try {
    const unpacked = unpackPluginPackage(await readFile(await buildIn(dir)))
    expect(unpacked.manifest.api).toBe(pluginApiRange(sdkPackage.version))
    expect(unpacked.manifest.api).toBe(pluginApiRange(PLUGIN_API_VERSION))
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)

test.each([
  ['没装 SDK', null, '找不到 @nextskin/plugin-sdk'],
  ['SDK 比构建命令新', bump(sdkPackage.version, 'minor'), '装成同一个版本'],
  ['SDK 的大版本不同', bump(sdkPackage.version, 'major'), '装成同一个版本'],
  ['SDK 的版本号不合法', 'next', '没有合法的版本号'],
] as const)(
  '插件项目里的 SDK 不合适时拒绝构建：%s',
  async (_, version, message) => {
    const dir = await project(version)
    try {
      await expect(exec(process.execPath, [cli, 'build', dir], { timeout: 20_000 })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(message) as unknown,
      })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
  30_000,
)

function bump(version: string, part: 'major' | 'minor'): string {
  const [major, minor] = version.split('.').map(Number) as [number, number]
  return part === 'major' ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`
}

/** 一个最小的插件项目；`sdk` 为 undefined 时链接仓库里的 SDK，为 null 时不装，为字符串时装一个只有版本号的假 SDK */
async function project(sdk?: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nextskin-sdk-version-'))
  await mkdir(join(dir, 'src'))
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'test', version: '1.0.0', nextskin: { id: 'test' } }),
  )
  await writeFile(join(dir, 'src', 'index.ts'), 'export default { capabilities: [] }')
  if (sdk === undefined) await installSdk(dir)
  else if (sdk !== null) {
    const fake = join(dir, 'node_modules', '@nextskin', 'plugin-sdk')
    await mkdir(fake, { recursive: true })
    await writeFile(
      join(fake, 'package.json'),
      JSON.stringify({ name: '@nextskin/plugin-sdk', version: sdk, exports: { './package.json': './package.json' } }),
    )
  }
  return dir
}

async function buildIn(dir: string): Promise<string> {
  const out = join(dir, 'plugin.tgz')
  await exec(process.execPath, [cli, 'build', dir, '--out', out], { timeout: 20_000 })
  return out
}

/* eslint-disable nextskin/no-raw-color -- 构建测试直接核对 manifest 中的主题色值数据。 */
test('构建主题和结构写进 manifest，色值统一为小写', async () => {
  const dir = await project()
  try {
    await writeFile(
      join(dir, 'src', 'index.ts'),
      `export default {
      capabilities: [],
      ui: { themes: [{ name: 'cobalt', label: 'themes.cobalt',
        structure: { radius: 'square', borders: 'thick', cards: 'raised' }, colors: {
        light: { accent: '#2A52E5' }, dark: { accent: '#86A2FF' }
      } }] }
    }`,
    )
    const { manifest } = unpackPluginPackage(await readFile(await buildIn(dir)))
    expect(manifest.ui.themes).toEqual([
      {
        name: 'cobalt',
        label: 'themes.cobalt',
        structure: { radius: 'square', borders: 'thick', cards: 'raised' },
        colors: { light: { accent: '#2a52e5' }, dark: { accent: '#86a2ff' } },
      },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)

test('结构取值错误使构建退出 1，并指出 structure', async () => {
  const dir = await project()
  try {
    await writeFile(
      join(dir, 'src', 'index.ts'),
      `export default {
      capabilities: [],
      ui: { themes: [{ name: 'bad', label: 'themes.bad', colors: {}, structure: { radius: 'round' } }] }
    }`,
    )
    await expect(exec(process.execPath, [cli, 'build', dir], { timeout: 20_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('structure.radius') as unknown,
    })
    await expect(readFile(join(dir, 'dist', 'test-1.0.0.tgz'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)

test('不通过的主题使构建退出 1，逐条报出主题名、模式和检查组合', async () => {
  const dir = await project()
  try {
    await writeFile(
      join(dir, 'src', 'index.ts'),
      `export default {
      capabilities: [],
      ui: { themes: [
        { name: 'bad-contrast', label: 'bad', colors: { light: { accent: '#ffffff' } } },
        { name: 'bad-direction', label: 'bad', colors: { light: { bg: '#000000' } } },
        { name: 'bad-distance', label: 'bad', colors: { dark: { accent: '#ff6b6b' } } }
      ] }
    }`,
    )
    await expect(exec(process.execPath, [cli, 'build', dir], { timeout: 20_000 })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /主题 bad-contrast：亮色下 accent-fg 和 accent 的对比度[\s\S]*主题 bad-direction：亮色下 bg 要比 text 亮[\s\S]*主题 bad-distance：暗色下 accent 和 danger 在 OKLab/,
      ) as unknown,
    })
    await expect(readFile(join(dir, 'dist', 'test-1.0.0.tgz'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30_000)
/* eslint-enable nextskin/no-raw-color */
