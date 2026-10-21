import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  DomainError,
  hostNetworkRestricted,
  openCore,
  pluginHostEntry,
  type PluginDetail,
  type PluginPackagePreview,
  type PluginSummary,
} from '@nextskin/domain'
import { createTranslator } from '@nextskin/i18n'
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest'
import type { CommandContext, ReadCommandContext } from '../context.ts'
import { run } from './plugin.ts'

vi.mock('@nextskin/domain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nextskin/domain')>()),
  openCore: vi.fn(),
}))
vi.mock('@nextskin/official-plugins', () => ({ officialPlugins: [] }))
vi.mock('node:readline', () => ({ createInterface: vi.fn() }))

const t = createTranslator('zh-CN')
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const context = {
  root: resolve(repository, 'apps/web'),
  cwd: resolve(repository, 'plugins'),
  source: true,
  config: {},
} as CommandContext
const read = vi.fn<ReadCommandContext>()
const readFile = vi.fn<(path: string) => Promise<Uint8Array>>()
const confirm = vi.fn<(question: string) => Promise<boolean>>()
const close = vi.fn()
const admin = {
  listAsSystem: vi.fn<() => Promise<PluginSummary[]>>(),
  detailAsSystem: vi.fn<(id: string) => Promise<PluginDetail>>(),
  previewAsSystem: vi.fn<(bytes: Uint8Array) => Promise<Preview>>(),
  installAsSystem: vi.fn(),
  enableAsSystem: vi.fn(),
  disableAsSystem: vi.fn(),
  uninstallImpactAsSystem: vi.fn<(id: string) => Promise<{ bindings: number; stranded: number }>>(),
  uninstallAsSystem: vi.fn(),
}
const bytes = new Uint8Array([1, 2, 3])
const options = { readFile, confirm, interactive: false }
let log: MockInstance<(message: string) => void>, error: MockInstance<(message: string) => void>
type Preview = PluginPackagePreview & { installedPackageHash: string | null; comparedWithInstalled: boolean }
let preview: Preview

function summary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'test-plugin',
    version: '2.0.0',
    official: false,
    enabled: false,
    running: false,
    lastError: null,
    deadLetters: 0,
    packageMissing: false,
    ...overrides,
  }
}
function detail(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return {
    ...summary(),
    manifest: preview.manifest,
    highRisk: [],
    logins: [],
    uninstallBindings: 0,
    strandedOnUninstall: 0,
    score: null,
    ...overrides,
  }
}
function upgrade(overrides: Partial<NonNullable<PluginPackagePreview['previous']>> = {}) {
  preview.action = 'upgrade'
  preview.installedPackageHash = 'installed-hash'
  preview.previous = {
    version: '1.0.0',
    enabled: false,
    addedCapabilities: [],
    addedNetwork: [],
    addedHighRisk: [],
    removedLogins: [],
    ...overrides,
  }
  admin.installAsSystem.mockResolvedValue({ id: 'test-plugin', version: '2.0.0', action: 'upgrade' })
}
const output = () => log.mock.calls.map(([line]) => line).join('\n')
const errors = () => error.mock.calls.map(([line]) => line).join('\n')

beforeEach(() => {
  vi.resetAllMocks()
  preview = {
    packageHash: 'preview-hash',
    installedPackageHash: null,
    comparedWithInstalled: true,
    action: 'install',
    previous: null,
    highRisk: [],
    messages: { 'zh-CN': { plugin: { name: '测试插件', description: '插件说明' } } },
    manifest: {
      manifestVersion: 1,
      id: 'test-plugin',
      version: '2.0.0',
      api: '^1.0.0',
      requires: {},
      conflicts: [],
      capabilities: [],
      network: [],
      settingsSchema: null,
      permissions: {},
      tables: [],
      migrations: [],
      events: [],
      interceptors: [],
      providers: { passwordHasher: [], login: [] },
      routes: [],
      jobs: [],
      cron: [],
      ui: {},
      entry: { server: 'server.mjs' },
      integrity: {},
    },
  }
  read.mockResolvedValue(context)
  readFile.mockResolvedValue(bytes)
  confirm.mockResolvedValue(true)
  close.mockResolvedValue(undefined)
  admin.listAsSystem.mockResolvedValue([summary()])
  admin.detailAsSystem.mockResolvedValue(detail())
  admin.uninstallImpactAsSystem.mockResolvedValue({ bindings: 0, stranded: 0 })
  admin.previewAsSystem.mockImplementation(() => Promise.resolve(preview))
  admin.installAsSystem.mockResolvedValue({ id: 'test-plugin', version: '2.0.0', action: 'install' })
  admin.enableAsSystem.mockResolvedValue({ changed: true })
  admin.disableAsSystem.mockResolvedValue({ changed: true })
  vi.mocked(openCore).mockResolvedValue({ core: { plugins: { admin } }, close } as unknown as Awaited<
    ReturnType<typeof openCore>
  >)
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

test.each([
  [],
  ['unknown'],
  ['list', 'extra'],
  ['list', ''],
  ['list', '--yes'],
  ['list', '--nope'],
  ['install'],
  ['install', 'a', 'b'],
  ['install', 'a', '--bad'],
  ['install', 'a', '--yes=no'],
  ['enable'],
  ['enable', 'test-plugin', '--yes'],
  ['disable', 'test-plugin', '--yes'],
  ['disable', 'test-plugin', 'extra'],
  ['uninstall'],
  ['help', 'extra'],
  ['--help', 'extra'],
])('错误参数 %j 不读配置、文件或打开核心', async (...argv) => {
  expect(await run(argv, read, options)).toBe(1)
  expect(errors()).toContain('用法：nextskin plugin <子命令>')
  expect(log).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(readFile).not.toHaveBeenCalled()
  expect(openCore).not.toHaveBeenCalled()
})

test.each(['--help', '-h', 'help'])('%s 在 stdout 打印完整用法，退出 0', async (flag) => {
  expect(await run([flag], read)).toBe(0)
  expect(output()).toContain('install <插件包> [--yes]')
  expect(output()).toContain('运行中的服务最多 5 秒后跟上。')
  expect(error).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(openCore).not.toHaveBeenCalled()
})

test.each([true, false])('打开核心使用 stage host；source=%s', async (source) => {
  const ctx = { ...context, source }
  read.mockResolvedValue(ctx)
  expect(await run(['--', 'list'], read)).toBe(0)
  expect(openCore).toHaveBeenCalledExactlyOnceWith(context.config, {
    startJobs: false,
    officialPlugins: [],
    pluginHostMode: 'stage',
    pluginLog: expect.any(Function) as unknown,
    pluginHost: pluginHostEntry({ root: source ? repository : resolve(context.root, 'server'), bundled: !source }),
  })
  // 插件系统的日志不进命令行的输出
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const [, options] = vi.mocked(openCore).mock.calls[0]!
  options?.pluginLog?.('[plugins] a activated version=1.0.0')
  expect(info).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalledWith('[plugins] a activated version=1.0.0')
  expect(close).toHaveBeenCalledOnce()
})

test('list 对齐 id 和版本，打印说明行，不显示进程运行状态', async () => {
  admin.listAsSystem.mockResolvedValue([
    summary({ id: 'a', version: '1.0.0', official: true, enabled: true, running: false }),
    summary({
      id: 'long-id',
      version: '10.20.30',
      running: true,
      packageMissing: true,
      lastError: '迁移有误',
      deadLetters: 2,
    }),
  ])
  expect(await run(['list'], read)).toBe(0)
  expect(log.mock.calls.map(([line]) => line)).toEqual([
    'a        1.0.0     官方  已启用',
    'long-id  10.20.30  上传  未启用',
    '  本实例取不到插件表里这个版本的插件包，插件在这里不可用：可以停用、卸载，或者恢复插件包的存储。',
    '  最近的错误：迁移有误',
    '  失败的任务：2 个（在后台的插件页重试或删除）',
  ])
})

test('list 空列表', async () => {
  admin.listAsSystem.mockResolvedValue([])
  expect(await run(['list'], read)).toBe(0)
  expect(log).toHaveBeenCalledExactlyOnceWith('没有插件。')
})

test('首次安装非终端没有 --yes 拒绝，仍打印预览并关闭核心', async () => {
  expect(await run(['install', 'plugin.tgz'], read, options)).toBe(1)
  expect(output()).toContain('安装 测试插件（test-plugin 2.0.0）\n插件说明')
  expect(output()).toContain(t('admin.plugins.upload.trust'))
  expect(output()).toContain('安装之后插件还不会运行，用 nextskin plugin enable test-plugin 启用。')
  expect(errors()).toBe('要确认才能安装：在终端里运行，或者加 --yes。')
  expect(admin.installAsSystem).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test('--yes 安装，read 后才读文件，路径按 cwd 解析，把预览原样交回', async () => {
  expect(await run(['install', '../包.tgz', '--yes'], read, options)).toBe(0)
  expect(readFile).toHaveBeenCalledExactlyOnceWith(resolve(context.cwd, '../包.tgz'))
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(readFile.mock.invocationCallOrder[0]!)
  expect(admin.previewAsSystem).toHaveBeenCalledExactlyOnceWith(bytes)
  expect(admin.installAsSystem).toHaveBeenCalledExactlyOnceWith(bytes, preview)
  expect(confirm).not.toHaveBeenCalled()
  expect(output()).toContain('已安装 测试插件 2.0.0。还没有启用：用 nextskin plugin enable test-plugin 启用。')
  expect(close).toHaveBeenCalledOnce()
})

test('读不到插件包只报告绝对路径，不打开核心', async () => {
  readFile.mockRejectedValue(new Error('不可回显的连接串'))
  expect(await run(['install', 'missing.tgz'], read, options)).toBe(1)
  expect(errors()).toBe(`读不到插件包 ${resolve(context.cwd, 'missing.tgz')}。`)
  expect(openCore).not.toHaveBeenCalled()
})

test.each([true, false])('终端安装确认=%s', async (accepted) => {
  confirm.mockResolvedValue(accepted)
  expect(await run(['install', 'plugin.tgz'], read, { ...options, interactive: true })).toBe(accepted ? 0 : 1)
  expect(confirm).toHaveBeenCalledExactlyOnceWith('确认安装？输入 y 确认：')
  expect(admin.installAsSystem).toHaveBeenCalledTimes(accepted ? 1 : 0)
  if (!accepted) expect(errors()).toBe('已取消，没有改动。')
  expect(close).toHaveBeenCalledOnce()
})

test.each([' y ', 'YeS', 'n', 'SIGINT', 'EOF'])('默认 readline 确认处理 %s，提示发到 stderr', async (input) => {
  const terminal = Object.assign(new EventEmitter(), {
    close: vi.fn(() => terminal.emit('close')),
    question: vi.fn((_question: string, answer: (input: string) => void) => {
      if (input === 'SIGINT') terminal.emit('SIGINT')
      else if (input === 'EOF') terminal.close()
      else answer(input)
    }),
  })
  vi.mocked(createInterface).mockReturnValue(terminal as unknown as ReturnType<typeof createInterface>)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const accepted = input === ' y ' || input === 'YeS'
  expect(await run(['install', 'plugin.tgz'], read, { readFile, interactive: true })).toBe(accepted ? 0 : 1)
  expect(createInterface).toHaveBeenCalledWith(
    expect.objectContaining({ input: process.stdin, output: process.stderr }),
  )
  expect(terminal.question).toHaveBeenCalledWith('确认安装？输入 y 确认：', expect.any(Function))
  expect(admin.installAsSystem).toHaveBeenCalledTimes(accepted ? 1 : 0)
  if (!accepted) expect(errors()).toBe('已取消，没有改动。')
  expect(close).toHaveBeenCalledOnce()
})

test('升级没有新增项直接升级，不询问；打印旧版本及停用提示', async () => {
  upgrade()
  expect(await run(['install', 'plugin.tgz'], read, options)).toBe(0)
  expect(output()).toContain('把 测试插件（test-plugin）从 1.0.0 升级到 2.0.0')
  expect(output()).toContain(t('admin.plugins.upload.upgradeDisabled'))
  expect(output()).toContain('已把 测试插件 升级到 2.0.0。运行中的服务最多 5 秒后跟上。')
  expect(admin.installAsSystem).toHaveBeenCalledOnce()
  expect(confirm).not.toHaveBeenCalled()
})

test.each(['addedCapabilities', 'addedNetwork', 'addedHighRisk', 'removedLogins'] as const)(
  '升级 %s 非空时必须确认',
  async (key) => {
    upgrade(
      key === 'removedLogins'
        ? { removedLogins: [{ providerId: 'old', label: 'login.old', bindings: 1 }] }
        : { [key]: ['new-item'] },
    )
    expect(await run(['install', 'plugin.tgz'], read, options)).toBe(1)
    expect(errors()).toBe('要确认才能升级：在终端里运行，或者加 --yes。')
    expect(admin.installAsSystem).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  },
)

test.each([true, false])('升级新增能力，终端确认=%s', async (accepted) => {
  upgrade({ addedCapabilities: ['users.readPrivate'] })
  confirm.mockResolvedValue(accepted)
  expect(await run(['install', 'plugin.tgz'], read, { ...options, interactive: true })).toBe(accepted ? 0 : 1)
  expect(confirm).toHaveBeenCalledExactlyOnceWith('确认升级？输入 y 确认：')
  expect(admin.installAsSystem).toHaveBeenCalledTimes(accepted ? 1 : 0)
})

test('完整升级预览：高风险、新增、接口、Provider、字段、任务、页面和去掉的登录方式', async () => {
  upgrade({
    enabled: true,
    addedCapabilities: ['users.readPrivate'],
    addedNetwork: ['https://example.com'],
    removedLogins: [
      { providerId: 'old', label: 'login.old', bindings: 3 },
      { providerId: 'fallback', label: 'missing', bindings: 1 },
    ],
  })
  preview.highRisk = ['users.readPrivate', 'provider.login', 'future.unknown']
  preview.messages = {
    'zh-CN': { plugin: { name: '中文名' }, login: { label: '新登录', old: '旧登录' }, field: { label: '注册信息' } },
    en: { plugin: { name: 'English', description: 'English description' }, page: { title: 'Plugin page' } },
  }
  preview.manifest = {
    ...preview.manifest,
    capabilities: ['users.readPrivate'],
    network: ['https://example.com'],
    events: ['user.registered'],
    interceptors: [{ name: 'user.register', priority: 0 }],
    providers: { passwordHasher: [], login: [{ id: 'new', label: 'login.label', icon: 'key' }] },
    routes: [
      { method: 'GET', path: '/', auth: 'public', permission: null, maxBodyBytes: 0, rateLimit: null },
      { method: 'POST', path: '/private', auth: 'user', permission: null, maxBodyBytes: 0, rateLimit: null },
    ],
    tables: ['records'],
    jobs: [{ name: 'sync', maxAttempts: 3, timeoutMs: 1000 }],
    cron: [{ schedule: '* * * * *', job: 'sync', payload: null }],
    ui: {
      formFields: [
        { form: 'auth.register', field: { type: 'text', name: 'info', label: 'field.label' }, fromQuery: true },
      ],
      pages: { home: { area: 'user', title: 'page.title', view: { kind: 'markdown', source: '/' } } },
    },
  }
  expect(await run(['install', 'plugin.tgz', '--yes'], read, options)).toBe(0)
  const text = output()
  expect(text).toContain('把 中文名（test-plugin）从 1.0.0 升级到 2.0.0\nEnglish description')
  expect(text).toContain(
    t('admin.plugins.upload.highRisk', { list: '读用户的邮箱、积分和语言、第三方登录、future.unknown' }),
  )
  expect(text).toContain(t('admin.plugins.upload.addedHint', { from: '1.0.0' }))
  expect(text).toContain('旧登录（3 个绑定）、fallback（1 个绑定）')
  const rows = [
    '  读写的数据：读用户的邮箱、积分和语言（高风险，新增）',
    '  访问的外部地址：https://example.com（新增）',
    '  处理的事件：user.registered',
    '  拦截的操作：注册：可以拒绝',
    '  提供的功能：第三方登录：新登录（高风险）',
    '  在注册表单上加的字段：注册信息（可以从链接预填）',
    '  提供的接口：GET /plugins/test-plugin（公开）、POST /plugins/test-plugin/private（要登录）',
    '  自己的数据表：records',
    '  后台任务：sync',
    '  定时任务：* * * * * → sync',
    '  加的页面：Plugin page',
  ]
  for (const row of rows) expect(text).toContain(row)
  expect(text.split('\n').filter((line) => line.startsWith('  '))).toEqual(rows)
  expect(text).toContain(t('admin.plugins.upload.upgradeEnabled'))
  expect(text.includes(t('admin.plugins.host.networkUnrestricted'))).toBe(!hostNetworkRestricted)
})

test('包文案缺少时名字回退到 id、没有描述，空 manifest 每行写无', async () => {
  preview.messages = {}
  expect(await run(['install', 'plugin.tgz', '--yes'], read, options)).toBe(0)
  expect(log.mock.calls[0]).toEqual(['安装 test-plugin（test-plugin 2.0.0）'])
  expect(log.mock.calls[1]).toEqual([t('admin.plugins.upload.trust')])
  expect(
    output()
      .split('\n')
      .filter((line) => line.startsWith('  ')),
  ).toHaveLength(11)
  expect(output()).toContain('  提供的接口：无')
})

test.each([
  ['enable', true, '已启用 test-plugin。运行中的服务最多 5 秒后跟上。'],
  ['enable', false, 'test-plugin 已经启用，没有改动。'],
  [
    'disable',
    true,
    '已停用 test-plugin：插件的数据、设置和排着队的任务都保留，重新启用后继续。运行中的服务最多 5 秒后跟上。',
  ],
  ['disable', false, 'test-plugin 已经停用，没有改动。'],
] as const)('%s changed=%s', async (command, changed, message) => {
  const method = command === 'enable' ? admin.enableAsSystem : admin.disableAsSystem
  method.mockResolvedValue({ changed })
  expect(await run([command, 'test-plugin'], read)).toBe(0)
  expect(method).toHaveBeenCalledExactlyOnceWith('test-plugin')
  expect(log).toHaveBeenCalledExactlyOnceWith(message)
  expect(close).toHaveBeenCalledOnce()
})

test.each([false, true])('enable 只有未启用时先打印高风险提示，enabled=%s', async (enabled) => {
  admin.detailAsSystem.mockResolvedValue(
    detail({ enabled, highRisk: ['users.readPrivate', 'provider.passwordHasher'] }),
  )
  expect(await run(['enable', 'test-plugin'], read)).toBe(0)
  const hint = t('admin.plugins.enableHighRisk', { list: '读用户的邮箱、积分和语言、核对旧系统的密码' })
  expect(output().includes(hint)).toBe(!enabled)
  if (!enabled) expect(log.mock.invocationCallOrder[0]).toBeLessThan(admin.enableAsSystem.mock.invocationCallOrder[0]!)
})

test('enable 取不到 detail 仍调用用例，由用例报错', async () => {
  admin.detailAsSystem.mockRejectedValue(new DomainError('plugin_not_found'))
  admin.enableAsSystem.mockRejectedValue(new DomainError('plugin_unavailable'))
  expect(await run(['enable', 'test-plugin'], read)).toBe(1)
  expect(admin.enableAsSystem).toHaveBeenCalledExactlyOnceWith('test-plugin')
  expect(errors()).toBe('本实例取不到这个插件的包，或者拉不起 plugin host。先运行 nextskin doctor 检查 plugin host。')
  expect(close).toHaveBeenCalledOnce()
})

test.each(['missing', 'official'])('卸载 %s 拒绝执行', async (kind) => {
  admin.listAsSystem.mockResolvedValue(kind === 'missing' ? [] : [summary({ official: true })])
  expect(await run(['uninstall', 'test-plugin', '--yes'], read, options)).toBe(1)
  expect(errors()).toBe(
    kind === 'missing'
      ? '找不到插件 test-plugin。'
      : '官方插件不能卸载，只能停用：nextskin plugin disable test-plugin。',
  )
  expect(admin.uninstallImpactAsSystem).not.toHaveBeenCalled()
  expect(admin.uninstallAsSystem).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test('卸载非终端需要 --yes，显示绑定和没有其他登录方式的用户数', async () => {
  admin.uninstallImpactAsSystem.mockResolvedValue({ bindings: 5, stranded: 1 })
  expect(await run(['uninstall', 'test-plugin'], read, options)).toBe(1)
  expect(admin.uninstallImpactAsSystem).toHaveBeenCalledExactlyOnceWith('test-plugin')
  expect(output()).toContain('卸载 test-plugin 2.0.0')
  expect(output()).toContain(t('admin.plugins.uninstall.dialogHint'))
  expect(output()).toContain(t('admin.plugins.uninstall.bindings', { bindings: 5, stranded: 1 }))
  expect(errors()).toBe('要确认才能卸载：在终端里运行，或者加 --yes。')
  expect(admin.uninstallAsSystem).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

test.each([true, false])('终端卸载确认=%s', async (accepted) => {
  confirm.mockResolvedValue(accepted)
  expect(await run(['uninstall', 'test-plugin'], read, { ...options, interactive: true })).toBe(accepted ? 0 : 1)
  expect(confirm).toHaveBeenCalledExactlyOnceWith('确认卸载？输入 y 确认：')
  expect(admin.uninstallAsSystem).toHaveBeenCalledTimes(accepted ? 1 : 0)
  if (!accepted) expect(errors()).toBe('已取消，没有改动。')
  expect(close).toHaveBeenCalledOnce()
})

test('取不到包的插件也能 --yes 卸载', async () => {
  admin.listAsSystem.mockResolvedValue([summary({ packageMissing: true })])
  admin.uninstallImpactAsSystem.mockResolvedValue({ bindings: 1, stranded: 0 })
  expect(await run(['uninstall', 'test-plugin', '--yes'], read, options)).toBe(0)
  expect(output()).toContain(t('admin.plugins.uninstall.bindings', { bindings: 1, stranded: 0 }))
  expect(admin.uninstallAsSystem).toHaveBeenCalledExactlyOnceWith('test-plugin')
  expect(confirm).not.toHaveBeenCalled()
  expect(output()).toContain(
    '已卸载 test-plugin。它的数据表和插件包由运行中的服务在 12 分钟后清理；服务没有运行的，下次启动后清理。',
  )
  expect(close).toHaveBeenCalledOnce()
})

test.each([
  [
    new DomainError('plugin_busy'),
    '这个插件正在被另一个操作改动（后台、另一个命令或卸载后的清理），或者刚被别人改过。用 nextskin plugin list 看看现在的状态再试。',
  ],
  [new DomainError('plugin_not_found'), '找不到插件 test-plugin。'],
  [
    new DomainError('plugin_load_failed', { message: '定义不匹配' }),
    '插件没能在 plugin host 里加载，所以没有启用。原因：定义不匹配',
  ],
  [new DomainError('plugin_load_failed'), '插件没能在 plugin host 里加载，所以没有启用。'],
  [
    new DomainError('plugin_requires_unmet', { plugin: 'dependency', range: '^1.0.0' }),
    '这个插件需要先安装并启用 dependency（^1.0.0）。',
  ],
  [
    new DomainError('plugin_future_unknown', { message: '不可回显' }),
    '插件命令执行失败，请检查环境变量和数据库是否可用。',
  ],
  [new DomainError('user_not_found'), '插件命令执行失败，请检查环境变量和数据库是否可用。'],
])('领域错误 %s 映射中文文案', async (failure, message) => {
  admin.enableAsSystem.mockRejectedValue(failure)
  expect(await run(['enable', 'test-plugin'], read)).toBe(1)
  expect(errors()).toBe(message)
  expect(close).toHaveBeenCalledOnce()
})

test.each(['reason', 'empty', 'list-fails'])('迁移失败读取 lastError：%s，读取发生在关闭核心前', async (kind) => {
  admin.enableAsSystem.mockRejectedValue(new DomainError('plugin_migration_failed'))
  if (kind === 'list-fails') admin.listAsSystem.mockRejectedValue(new Error('不可回显'))
  else admin.listAsSystem.mockResolvedValue([summary({ lastError: kind === 'reason' ? '表结构不符' : null })])
  expect(await run(['enable', 'test-plugin'], read)).toBe(1)
  expect(errors()).toBe('插件的数据表没有建好，所以没有启用。' + (kind === 'reason' ? '原因：表结构不符' : ''))
  expect(admin.listAsSystem.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!)
  expect(close).toHaveBeenCalledOnce()
})

test('升级比较的不是装着的包：说明原因，要确认', async () => {
  upgrade()
  preview.comparedWithInstalled = false
  expect(await run(['install', 'plugin.tgz'], read, options)).toBe(1)
  expect(output()).toContain(
    '上面的"新增"不是和装着的 1.0.0 比的（本实例取不到它的插件包，或者它刚被别人升级），所以要确认。',
  )
  expect(errors()).toBe('要确认才能升级：在终端里运行，或者加 --yes。')
  expect(admin.installAsSystem).not.toHaveBeenCalled()
  expect(await run(['install', 'plugin.tgz', '--yes'], read, options)).toBe(0)
  expect(admin.installAsSystem).toHaveBeenCalledOnce()
})

test('不用确认的升级在预览之后插件被改过：用例报冲突，不改成首次安装', async () => {
  upgrade()
  admin.installAsSystem.mockRejectedValue(new DomainError('plugin_busy'))
  expect(await run(['install', 'plugin.tgz'], read, options)).toBe(1)
  expect(confirm).not.toHaveBeenCalled()
  expect(admin.installAsSystem).toHaveBeenCalledExactlyOnceWith(
    bytes,
    expect.objectContaining({ installedPackageHash: 'installed-hash' }),
  )
  expect(errors()).toContain('刚被别人改过')
  expect(close).toHaveBeenCalledOnce()
})

test('安装预览报 plugin_not_found 时没有 id', async () => {
  admin.previewAsSystem.mockRejectedValue(new DomainError('plugin_not_found'))
  expect(await run(['install', 'plugin.tgz', '--yes'], read, options)).toBe(1)
  expect(errors()).toBe('找不到这个插件。')
  expect(close).toHaveBeenCalledOnce()
})

test.each(['open', 'list', 'preview', 'install', 'enable', 'disable', 'uninstall', 'confirm', 'close'] as const)(
  '%s 意外失败不回显原文，打开的核心总关闭，close 失败也退出 1',
  async (kind) => {
    const failure = new Error('数据库连接串和令牌不可回显')
    if (kind === 'open') vi.mocked(openCore).mockRejectedValue(failure)
    if (kind === 'list') admin.listAsSystem.mockRejectedValue(failure)
    if (kind === 'preview') admin.previewAsSystem.mockRejectedValue(failure)
    if (kind === 'install') admin.installAsSystem.mockRejectedValue(failure)
    if (kind === 'enable') admin.enableAsSystem.mockRejectedValue(failure)
    if (kind === 'disable') admin.disableAsSystem.mockRejectedValue(failure)
    if (kind === 'uninstall') admin.uninstallAsSystem.mockRejectedValue(failure)
    if (kind === 'confirm') confirm.mockRejectedValue(failure)
    if (kind === 'close') close.mockRejectedValue(failure)
    const argv =
      kind === 'preview' || kind === 'install'
        ? ['install', 'plugin.tgz', '--yes']
        : kind === 'enable' || kind === 'disable' || kind === 'uninstall'
          ? [kind, 'test-plugin', ...(kind === 'uninstall' ? ['--yes'] : [])]
          : kind === 'confirm'
            ? ['install', 'plugin.tgz']
            : ['list']
    expect(await run(argv, read, { ...options, interactive: true })).toBe(1)
    expect(errors()).toBe('插件命令执行失败，请检查环境变量和数据库是否可用。')
    expect(close).toHaveBeenCalledTimes(kind === 'open' ? 0 : 1)
  },
)
