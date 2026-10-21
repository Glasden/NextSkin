// 管理插件，不用后台、不用超级管理员会话（ADR-0049）。
//   nextskin plugin list | install <插件包> [--yes] | enable <id> | disable <id> | uninstall <id> [--yes]
// 调用后台的同一组用例，操作者是 system，照样写审计记录，IP 为空。服务运行时也能执行：
// 运行中的服务每 5 秒和插件表同步一次，命令行存进去的包、改过的状态由它自己接上。
// 启用、升级安装插件时临时拉起一个只有这个插件的 plugin host，加载、跑完迁移就退出
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import {
  DomainError,
  hostNetworkRestricted,
  openCore,
  type PluginPackagePreview,
  type PluginSummary,
} from '@nextskin/domain'
import { createTranslator } from '@nextskin/i18n'
import { officialPlugins } from '@nextskin/official-plugins'
import type { ReadCommandContext } from '../context.ts'
import { launcherPluginHost } from '../plugin-host.ts'

const USAGE = `用法：nextskin plugin <子命令>

  list                       列出插件和状态
  install <插件包> [--yes]   安装或升级上传的插件（nextskin-plugin build 生成的 .tgz）
  enable <id>                启用插件
  disable <id>               停用插件
  uninstall <id> [--yes]     卸载上传的插件，删掉它的数据

--yes 跳过确认。服务运行时也可以执行，运行中的服务最多 5 秒后跟上。`
const FAILED = '插件命令执行失败，请检查环境变量和数据库是否可用。'
const t = createTranslator('zh-CN')
// 能力、拦截点和错误码来自运行时，先用 has 检查再交给类型化的翻译器。
function translated(key: string, fallback: string, params?: DomainError['params']): string {
  return t.has(key as Parameters<typeof t.has>[0]) ? t(key as Parameters<typeof t>[0], params) : fallback
}
function capability(item: string): string {
  const key = item.startsWith('provider.')
    ? `admin.plugins.providers.${item.slice('provider.'.length)}`
    : `admin.plugins.capabilities.${item}`
  return translated(key, item)
}

interface Options {
  confirm?: (question: string) => Promise<boolean>
  interactive?: boolean
  readFile?: (path: string) => Promise<Uint8Array>
}
type PluginAdmin = Awaited<ReturnType<typeof openCore>>['core']['plugins']['admin']

function parse(argv: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { yes: { type: 'boolean' } },
      strict: true,
      allowPositionals: true,
    })
    const [command, target, ...extra] = positionals
    if (extra.length) return null
    if (command === 'list' && positionals.length === 1 && values.yes === undefined)
      return { command, target, yes: false }
    if (!target) return null
    if (command === 'install' || command === 'uninstall') return { command, target, yes: values.yes === true }
    if ((command === 'enable' || command === 'disable') && values.yes === undefined)
      return { command, target, yes: false }
    return null
  } catch {
    return null
  }
}

/** readline 的 close 同时涵盖 Ctrl+C 和 Ctrl+D；只认明确输入的 y / yes。 */
function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true, historySize: 0 })
    rl.on('SIGINT', () => rl.close())
    rl.once('close', () => {
      process.stderr.write('\n')
      resolve(false)
    })
    rl.question(question, (answer) => {
      resolve(/^(y|yes)$/i.test(answer.trim()))
      rl.close()
    })
  })
}

async function confirm(action: string, yes: boolean, options: Options): Promise<boolean> {
  if (yes) return true
  if (!(options.interactive ?? process.stdin.isTTY === true)) {
    console.error(`要确认才能${action}：在终端里运行，或者加 --yes。`)
    return false
  }
  if (await (options.confirm ?? promptConfirm)(`确认${action}？输入 y 确认：`)) return true
  console.error('已取消，没有改动。')
  return false
}

/** 包里的文案还没注册到核心：按点分路径查中文，缺少时查英文。 */
function packageTranslator(messages: PluginPackagePreview['messages']) {
  return (key: string): string | undefined => {
    for (const locale of ['zh-CN', 'en']) {
      let value: unknown = messages[locale]
      for (const part of key.split('.')) {
        value =
          value && typeof value === 'object' && Object.hasOwn(value, part)
            ? (value as Record<string, unknown>)[part]
            : undefined
      }
      if (typeof value === 'string') return value
    }
    return undefined
  }
}

function printList(plugins: PluginSummary[]) {
  if (!plugins.length) {
    console.log('没有插件。')
    return
  }
  const idWidth = Math.max(...plugins.map(({ id }) => id.length))
  const versionWidth = Math.max(...plugins.map(({ version }) => version.length))
  for (const plugin of plugins) {
    console.log(
      `${plugin.id.padEnd(idWidth)}  ${plugin.version.padEnd(versionWidth)}  ${plugin.official ? '官方' : '上传'}  ${plugin.enabled ? '已启用' : '未启用'}`,
    )
    if (plugin.packageMissing)
      console.log('  本实例取不到插件表里这个版本的插件包，插件在这里不可用：可以停用、卸载，或者恢复插件包的存储。')
    if (plugin.lastError) console.log(`  最近的错误：${plugin.lastError}`)
    if (plugin.deadLetters > 0) console.log(`  失败的任务：${plugin.deadLetters} 个（在后台的插件页重试或删除）`)
  }
}

function printPreview(preview: PluginPackagePreview): string {
  const { manifest, previous, highRisk } = preview
  const message = packageTranslator(preview.messages)
  const translate = (key: string) => message(key) ?? key
  const name = message('plugin.name') ?? manifest.id
  console.log(
    previous
      ? `把 ${name}（${manifest.id}）从 ${previous.version} 升级到 ${manifest.version}`
      : `安装 ${name}（${manifest.id} ${manifest.version}）`,
  )
  const description = message('plugin.description')
  if (description) console.log(description)
  console.log(t('admin.plugins.upload.trust'))
  if (highRisk.length) console.log(t('admin.plugins.upload.highRisk', { list: highRisk.map(capability).join('、') }))
  if (previous && (previous.addedCapabilities.length || previous.addedNetwork.length))
    console.log(t('admin.plugins.upload.addedHint', { from: previous.version }))
  if (previous?.removedLogins.length) {
    console.log(
      t('admin.plugins.upload.removedLogins', {
        list: previous.removedLogins
          .map((login) =>
            t('admin.plugins.upload.removedLogin', {
              name: message(login.label) ?? login.providerId,
              count: login.bindings,
            }),
          )
          .join('、'),
      }),
    )
  }
  if (!hostNetworkRestricted) console.log(t('admin.plugins.host.networkUnrestricted'))
  console.log(t('admin.plugins.manifest.title'))
  const marked = (value: string, risk: boolean, added: boolean) => {
    const marks = [
      risk ? t('admin.plugins.manifest.highRisk') : '',
      added ? t('admin.plugins.upload.added') : '',
    ].filter(Boolean)
    return value + (marks.length ? `（${marks.join('，')}）` : '')
  }
  const rows: [string, readonly string[]][] = [
    [
      'capabilities',
      manifest.capabilities.map((item) =>
        marked(capability(item), highRisk.includes(item), previous?.addedCapabilities.includes(item) ?? false),
      ),
    ],
    ['network', manifest.network.map((item) => marked(item, false, previous?.addedNetwork.includes(item) ?? false))],
    ['events', manifest.events],
    ['interceptors', manifest.interceptors.map(({ name }) => translated(`admin.plugins.interceptors.${name}`, name))],
    [
      'providers',
      (['passwordHasher', 'login'] as const).flatMap((kind) =>
        manifest.providers[kind].map((provider) =>
          marked(
            t('admin.plugins.manifest.providerItem', {
              kind: t(`admin.plugins.providers.${kind}`),
              label: translate(provider.label),
            }),
            highRisk.includes(`provider.${kind}`),
            false,
          ),
        ),
      ),
    ],
    [
      'formFields',
      (manifest.ui.formFields ?? []).map(
        ({ field, fromQuery }) =>
          translate(field.label) + (fromQuery ? `（${t('admin.plugins.manifest.fromQuery')}）` : ''),
      ),
    ],
    [
      'routes',
      manifest.routes.map(
        (route) =>
          `${route.method} /plugins/${manifest.id}${route.path === '/' ? '' : route.path}（${t('admin.plugins.manifest.routeAuth', { auth: route.auth })}）`,
      ),
    ],
    ['tables', manifest.tables],
    ['jobs', manifest.jobs.map(({ name }) => name)],
    ['cron', manifest.cron.map(({ schedule, job }) => `${schedule} → ${job}`)],
    ['pages', Object.values(manifest.ui.pages ?? {}).map((page) => translate(page.title))],
  ]
  for (const [key, items] of rows)
    console.log(
      `  ${translated(`admin.plugins.manifest.${key}`, key)}：${items.length ? items.join('、') : t('admin.plugins.manifest.none')}`,
    )
  console.log(
    previous
      ? t(previous.enabled ? 'admin.plugins.upload.upgradeEnabled' : 'admin.plugins.upload.upgradeDisabled')
      : `安装之后插件还不会运行，用 nextskin plugin enable ${manifest.id} 启用。`,
  )
  return name
}

async function describeError(error: unknown, id?: string, admin?: PluginAdmin): Promise<string> {
  if (!(error instanceof DomainError)) return FAILED
  switch (error.code) {
    case 'plugin_not_found':
      return id ? `找不到插件 ${id}。` : '找不到这个插件。'
    case 'plugin_busy':
      return '这个插件正在被另一个操作改动（后台、另一个命令或卸载后的清理），或者刚被别人改过。用 nextskin plugin list 看看现在的状态再试。'
    case 'plugin_migration_failed': {
      const plugins = await admin?.listAsSystem().catch(() => [])
      const reason = plugins?.find((plugin) => plugin.id === id)?.lastError
      return '插件的数据表没有建好，所以没有启用。' + (reason ? `原因：${reason}` : '')
    }
    case 'plugin_load_failed':
      return (
        '插件没能在 plugin host 里加载，所以没有启用。' + (error.params?.message ? `原因：${error.params.message}` : '')
      )
    case 'plugin_unavailable':
      return '本实例取不到这个插件的包，或者拉不起 plugin host。先运行 nextskin doctor 检查 plugin host。'
    default:
      return error.code.startsWith('plugin_') ? translated(`errors.${error.code}`, FAILED, error.params) : FAILED
  }
}

export async function run(argv: string[], read: ReadCommandContext, options: Options = {}): Promise<number> {
  const raw = argv[0] === '--' ? argv.slice(1) : argv
  if (raw.length === 1 && ['--help', '-h', 'help'].includes(raw[0]!)) {
    console.log(USAGE)
    return 0
  }
  const args = parse(raw)
  if (!args) {
    console.error(USAGE)
    return 1
  }
  const context = await read()
  let bytes: Uint8Array | undefined
  if (args.command === 'install') {
    const path = resolve(context.cwd, args.target!)
    try {
      bytes = await (options.readFile ?? readFile)(path)
    } catch {
      console.error(`读不到插件包 ${path}。`)
      return 1
    }
  }
  let id = args.command === 'install' ? undefined : args.target
  try {
    const opened = await openCore(context.config, {
      startJobs: false,
      officialPlugins,
      pluginHost: launcherPluginHost(context),
      pluginHostMode: 'stage',
      // 插件系统记的是本进程里的登记和撤销（命令行退出前总会撤销），对执行命令的人只是噪音；结果由命令自己写
      pluginLog: () => {},
    })
    const admin = opened.core.plugins.admin
    try {
      switch (args.command) {
        case 'list':
          printList(await admin.listAsSystem())
          break
        case 'install': {
          const preview = await admin.previewAsSystem(bytes!)
          id = preview.manifest.id
          const name = printPreview(preview)
          const { previous } = preview
          if (previous && !preview.comparedWithInstalled)
            console.log(
              `上面的"新增"不是和装着的 ${previous.version} 比的（本实例取不到它的插件包，或者它刚被别人升级），所以要确认。`,
            )
          const needsConfirmation =
            preview.action === 'install' ||
            (!!previous &&
              (!preview.comparedWithInstalled ||
                [
                  previous.addedCapabilities,
                  previous.addedNetwork,
                  previous.addedHighRisk,
                  previous.removedLogins,
                ].some((items) => items.length > 0)))
          if (needsConfirmation && !(await confirm(preview.action === 'install' ? '安装' : '升级', args.yes, options)))
            return 1
          // 预览之后插件被别人装上、升级或卸载了就报冲突：要不要确认是按预览决定的
          const result = await admin.installAsSystem(bytes!, preview)
          console.log(
            result.action === 'install'
              ? `已安装 ${name} ${result.version}。还没有启用：用 nextskin plugin enable ${result.id} 启用。`
              : `已把 ${name} 升级到 ${result.version}。运行中的服务最多 5 秒后跟上。`,
          )
          break
        }
        case 'enable': {
          const detail = await admin.detailAsSystem(args.target!).catch(() => undefined)
          if (detail && !detail.enabled && detail.highRisk.length)
            console.log(t('admin.plugins.enableHighRisk', { list: detail.highRisk.map(capability).join('、') }))
          const { changed } = await admin.enableAsSystem(args.target!)
          console.log(
            changed ? `已启用 ${args.target}。运行中的服务最多 5 秒后跟上。` : `${args.target} 已经启用，没有改动。`,
          )
          break
        }
        case 'disable': {
          const { changed } = await admin.disableAsSystem(args.target!)
          console.log(
            changed
              ? `已停用 ${args.target}：插件的数据、设置和排着队的任务都保留，重新启用后继续。运行中的服务最多 5 秒后跟上。`
              : `${args.target} 已经停用，没有改动。`,
          )
          break
        }
        case 'uninstall': {
          const plugin = (await admin.listAsSystem()).find((plugin) => plugin.id === args.target)
          if (!plugin) {
            console.error(`找不到插件 ${args.target}。`)
            return 1
          }
          if (plugin.official) {
            console.error(`官方插件不能卸载，只能停用：nextskin plugin disable ${args.target}。`)
            return 1
          }
          const { bindings, stranded } = await admin.uninstallImpactAsSystem(args.target!)
          console.log(`卸载 ${plugin.id} ${plugin.version}`)
          console.log(t('admin.plugins.uninstall.dialogHint'))
          if (bindings) console.log(t('admin.plugins.uninstall.bindings', { bindings, stranded }))
          if (!(await confirm('卸载', args.yes, options))) return 1
          await admin.uninstallAsSystem(args.target!)
          console.log(
            `已卸载 ${args.target}。它的数据表和插件包由运行中的服务在 12 分钟后清理；服务没有运行的，下次启动后清理。`,
          )
          break
        }
      }
      return 0
    } catch (error) {
      console.error(await describeError(error, id, admin))
      return 1
    } finally {
      await opened.close()
    }
  } catch (error) {
    // 包括打开、关闭核心失败；意外错误可能带连接串，不回显原文。
    console.error(await describeError(error, id))
    return 1
  }
}
