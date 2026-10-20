import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createFrameChannel } from './channel.ts'
import { pluginHostEntry } from './entry.ts'
import type { CoreToHost, HostToCore, HostPluginSpec } from './protocol.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

test('源码模式只允许 host、SDK 和依赖各自的 pnpm 层，不允许应用和共享依赖目录', () => {
  const { readPaths } = pluginHostEntry({ root: repository, bundled: false })
  const modules = join(repository, 'node_modules')
  expect(readPaths).toContain(join(repository, 'packages', 'plugin-host'))
  expect(readPaths).toContain(join(repository, 'packages', 'plugin-sdk'))
  expect(readPaths).not.toContain(modules)
  expect(readPaths).not.toContain(join(modules, '.pnpm'))
  expect(readPaths).not.toContain(join(modules, '.pnpm', 'node_modules'))
  expect(new Set(readPaths).size).toBe(readPaths.length)
  for (const path of readPaths) {
    expect(relative(repository, path).split(sep)[0]).not.toBe('apps')
    if (!path.startsWith(join(repository, 'packages') + sep))
      expect(relative(join(modules, '.pnpm'), path).split(sep)).toEqual([expect.any(String), 'node_modules'])
  }
})

test('打包模式只允许生成的单文件，不遍历源码依赖', () => {
  const script = join('standalone', 'packages', 'plugin-host', 'dist', 'host.mjs')
  expect(pluginHostEntry({ root: 'standalone', bundled: true })).toEqual({ script, readPaths: [script] })
})

test('遍历依赖、可选依赖和 peer，跳过未安装的可选项和开发依赖，拒绝其他工作区包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nextskin-host-dependencies-'))
  const host = join(root, 'packages', 'plugin-host')
  const sdk = join(root, 'packages', 'plugin-sdk')
  const first = join(root, 'node_modules', '.pnpm', 'first@1', 'node_modules')
  const second = join(root, 'node_modules', '.pnpm', 'second@1', 'node_modules')
  async function json(dir: string, value: unknown) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify(value))
  }
  async function link(from: string, to: string) {
    await mkdir(dirname(to), { recursive: true })
    await symlink(from, to, 'junction')
  }
  try {
    await json(host, {
      dependencies: { '@nextskin/plugin-sdk': '*' },
      optionalDependencies: { first: '*', missing: '*' },
      devDependencies: { ignored: '*' },
    })
    await json(sdk, { dependencies: { first: '*' }, devDependencies: { ignored: '*' } })
    await json(join(first, 'first'), {
      dependencies: { '@nextskin/plugin-sdk': '*' },
      optionalDependencies: { missing: '*' },
      peerDependencies: { '@test/second': '*', missingPeer: '*' },
    })
    await json(join(second, '@test', 'second'), { dependencies: { first: '*' } })
    await link(sdk, join(host, 'node_modules', '@nextskin', 'plugin-sdk'))
    await link(sdk, join(first, '@nextskin', 'plugin-sdk'))
    await link(join(first, 'first'), join(host, 'node_modules', 'first'))
    await link(join(first, 'first'), join(sdk, 'node_modules', 'first'))
    await link(join(first, 'first'), join(second, 'first'))
    await link(join(second, '@test', 'second'), join(first, '@test', 'second'))
    expect(pluginHostEntry({ root, bundled: false }).readPaths).toEqual([host, sdk, first, second])
    await json(join(second, '@test', 'second'), { dependencies: { missingRequired: '*' } })
    expect(() => pluginHostEntry({ root, bundled: false })).toThrow('缺少运行时依赖 missingRequired')
    const other = join(root, 'packages', 'other')
    await json(other, {})
    await link(other, join(second, '@nextskin', 'other'))
    await json(join(second, '@test', 'second'), { dependencies: { '@nextskin/other': '*' } })
    expect(() => pluginHostEntry({ root, bundled: false })).toThrow('不允许读取工作区依赖 @nextskin/other')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function startHost(
  plugins: HostPluginSpec[] = [],
  env: NodeJS.ProcessEnv = {},
  afterReady?: (child: ChildProcessWithoutNullStreams) => Promise<void>,
) {
  const entry = pluginHostEntry({ root: repository, bundled: false })
  const child = spawn(
    process.execPath,
    [
      '--permission',
      ...[...entry.readPaths, ...plugins.map((p) => p.dir)].map((p) => `--allow-fs-read=${p}`),
      entry.script,
    ],
    { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text
  })
  const exited = once(child, 'exit')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = await new Promise<HostToCore>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`host 未就绪：${stderr}`)), 10_000)
      child.once('error', reject)
      child.once('exit', () => reject(new Error(`host 提前退出：${stderr}`)))
      const channel = createFrameChannel<HostToCore, CoreToHost>({
        input: child.stdout,
        output: child.stdin,
        onMessage: resolve,
        onClose: (error) => {
          if (error) reject(error)
        },
      })
      channel.send({ type: 'init', dialect: 'sqlite', fallbackLocale: 'zh-CN', plugins })
    })
    await afterReady?.(child)
    return ready
  } finally {
    clearTimeout(timer)
    // 和核心一样关掉 stdin 让它退出；卡住时由测试超时暴露，不在这里强杀掩盖
    child.stdin.end()
    await exited
  }
}

test('真实权限子进程在缩小的可读路径下能加载源码并响应空 init', async () => {
  expect(await startHost()).toEqual({ type: 'ready', plugins: [] })
})

// Windows 上 kill(信号) 一律直接结束进程，测不了
test.skipIf(process.platform === 'win32')(
  '收到 SIGINT、SIGTERM 不退出，等核心关掉 stdin',
  async () => {
    await startHost([], {}, async (child) => {
      child.kill('SIGINT')
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
    })
  },
  15_000,
)

test('host 加载插件前清空环境，包括 Windows 可能补入的变量；Windows 上留着 SYSTEMROOT，插件照样能取随机数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nextskin-host-env-'))
  try {
    await writeFile(
      join(dir, 'server.mjs'),
      `
      import assert from 'node:assert/strict';
      assert.deepEqual(Object.keys(process.env), ${JSON.stringify(process.platform === 'win32' ? ['SYSTEMROOT'] : [])});
      assert.equal(crypto.getRandomValues(new Uint8Array(8)).length, 8);
      export default { capabilities: [] };
    `,
    )
    const result = await startHost([{ id: 'probe', version: '1.0.0', dir, entry: 'server.mjs', messages: {} }], {
      ...process.env,
      NEXTSKIN_HOST_TEST: 'test',
      TEMP: dir,
      USERPROFILE: dir,
    })
    expect(result).toMatchObject({ type: 'ready', plugins: [{ id: 'probe', ok: true }] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
