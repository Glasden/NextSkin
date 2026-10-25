import { resolve } from 'node:path'
import { createDiagnostics } from './diagnostics/service.ts'
import type { DiagnosticsRuntime } from './diagnostics/types.ts'
import type { Logger } from '@nextskin/logging'
import { createOAuthClients } from './oauth/clients.ts'
import { createDevices } from './oauth/devices.ts'
import { createAuthorizations } from './oauth/authorizations.ts'
import { deleteOAuthTokensForUser, deleteClaimedDeviceCodes } from './oauth/revoke.ts'
import { createSetup } from './setup/service.ts'
import { createTokens } from './yggdrasil/tokens.ts'
import { createSessions } from './yggdrasil/join.ts'
import { createProfileTextures } from './yggdrasil/profile-textures.ts'
import { createMemorySessionCache, type YggdrasilSessionCache } from './yggdrasil/sessions.ts'
import { createScheduler } from './jobs/schedules.ts'
import { AUTH_CLEANUP_JOB, createAuthCleanup } from './auth/cleanup.ts'
import { AUDIT_CLEANUP_JOB, createAuditCleanup } from './audit/cleanup.ts'
import { TEXTURE_SWEEP_JOB, createTextureSweep } from './textures/sweep.ts'
import { SITE_IMAGE_SWEEP_JOB, createSiteImageSweep } from './site-images/sweep.ts'
import { createMemorySiteImageStorage, isSiteImageFile, type SiteImageStorage } from './site-images/storage.ts'
import { createThemes } from './themes/service.ts'
import { createCustomCode } from './custom-code/service.ts'
import { createAdmin } from './admin/service.ts'
import { createCloset } from './closet/service.ts'
import { createReports } from './reports/service.ts'
import { createNotificationJobs, NOTIFICATION_SWEEP_JOB } from './notifications/jobs.ts'
import { createNotifications } from './notifications/service.ts'
import { dialectOf, toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import { createPluginDbGateway } from './plugins/db/gateway.ts'
import { createPluginSystem, PLUGIN_CLEANUP_JOB, type OfficialPlugin } from './plugins/system.ts'
import type { PluginHostEntry } from './plugins/host.ts'
import type { PluginPackages } from './plugins/packages.ts'
import type { loadPlugin } from '@nextskin/plugin-host'
import { createPluginAdmin } from './plugins/admin.ts'
import { deleteLauncherTokens } from './auth/revoke.ts'
import { PLUGIN_KV_CLEANUP_JOB } from './plugins/kv.ts'
import { pluginReferences } from './plugins/references.ts'
import type { Kysely } from 'kysely'
import { createAuthService } from './auth/service.ts'
import { createCaptcha } from './captcha/service.ts'
import { createExternalLogin } from './auth/external-login.ts'
import { createEvents } from './events/emit.ts'
import { createJobRunner, type JobHandler, type JobRunnerOptions } from './jobs/runner.ts'
import { createMailService, MAIL_JOB } from './mail/service.ts'
import type { MailTransport } from './mail/types.ts'
import { createPlayerManagement } from './players/manage.ts'
import { createCheckIn } from './users/check-in.ts'
import { createUserManagement } from './users/manage.ts'
import { createHomeQueries } from './home/queries.ts'
import { createUserQueries } from './users/queries.ts'
import { createScoreQueries } from './score/queries.ts'
import { createRegister } from './users/register.ts'
import { createPlayerQueries } from './players/queries.ts'
import { validateSecretKey } from './settings/codec.ts'
import { createSettingQueries } from './settings/queries.ts'
import { createTextureLibraryQueries, createTextureQueries } from './textures/queries.ts'
import { createImagePool, type ImagePool } from './textures/image-pool.ts'
import { createMemoryRenderCache, type RenderCache } from './textures/render-cache.ts'
import { createRenders } from './textures/renders.ts'
import type { TextureStorage } from './textures/storage.ts'
import { createTextureFiles } from './textures/files.ts'
import { createTextureManagement } from './textures/manage.ts'
import { createTextureRemoval } from './textures/removal.ts'
import { createTextureUpload } from './textures/upload.ts'
import { createSigningKeyQuery } from './yggdrasil/signing-key.ts'
import { createUpdates, UPDATE_CHECK_JOB, type CoreRelease, type UpdateCheckOptions } from './updates/service.ts'
import type { ManagerClientOptions } from './updates/manager-client.ts'

export interface CoreOptions extends Partial<DiagnosticsRuntime> {
  dataDirectory?: string
  manager?: ManagerClientOptions
  release?: CoreRelease
  updateCheck?: UpdateCheckOptions
  setupCodeFile?: string | null
  db: Kysely<CoreDatabase>
  textureStorage: TextureStorage
  /** 站点图片的存储（ADR-0042），默认存在内存里 */
  siteImageStorage?: SiteImageStorage
  /** 领域用例与任务共享的时钟；同时供任务执行器入队和轮询使用。 */
  now?: () => Date
  textureClaimLeaseMs?: number
  textureDeleteDelayMs?: number
  /** 删除尝试的租期，默认 10 分钟，应远大于回收任务的超时。 */
  textureDeleteAttemptLeaseMs?: number
  /** 多实例部署时，进服记录需要使用共享存储。 */
  yggdrasilSessionCache?: YggdrasilSessionCache
  renderCache?: RenderCache
  imagePool?: ImagePool
  /** .env 里的密钥，用来解密机密设置；至少 32 个字符。 */
  secretKey: string
  /** 生产环境：站点地址必须在设置里填写（auth/service.ts） */
  production: boolean
  mailTransport?: MailTransport
  /** 任务执行器的参数，测试用来控制时钟和轮询 */
  jobs?: Omit<JobRunnerOptions, 'db' | 'handlers'>
  captcha?: { fetch?: typeof fetch }
  plugins?: {
    /** 随发行包分发的官方插件，在核心进程内运行（ADR-0009） */
    official?: readonly OfficialPlugin[]
    /** SQLite 的数据库文件：插件的读查询走专用的只读 worker 连接（ADR-0033） */
    sqliteFile?: string
    /** 每个实例多久读一次插件的启用集合，默认 5 秒 */
    syncIntervalMs?: number
    logger?: Logger
    /** 测试用：替换进程内的插件加载 */
    load?: typeof loadPlugin
    /** plugin host 的入口；没有时安装插件不运行（命令行脚本） */
    host?: PluginHostEntry | null
    /** `stage`：host 只用来准备启用、升级的插件，不运行安装插件（命令行管理插件，plugins/system.ts） */
    hostMode?: 'run' | 'stage'
    /** 安装插件的包（存储接口）和本实例解开的目录 */
    packages?: PluginPackages | null
    /** host 崩溃后的重启策略；测试用来缩短等待 */
    hostRestart?: { maxCrashes?: number; baseDelayMs?: number }
    /** 测试用：代插件发出站请求的 fetch（plugins/system.ts） */
    fetch?: typeof fetch
  }
}

export function createCore(options: CoreOptions) {
  validateSecretKey(options.secretKey)
  const imagePool = options.imagePool ?? createImagePool()
  const renders = createRenders({
    db: options.db,
    storage: options.textureStorage,
    cache: options.renderCache ?? createMemoryRenderCache(),
    pool: imagePool,
  })
  const settings = createSettingQueries(options.db, options.secretKey)
  const siteImages = options.siteImageStorage ?? createMemorySiteImageStorage()
  const captcha = createCaptcha(settings, options.captcha?.fetch)
  // 执行器每次轮询都读这张表，事件订阅和核心任务往里登记处理函数
  const handlers = new Map<string, JobHandler>()
  const now = options.now ?? options.jobs?.now ?? (() => new Date())
  const startedAt = toIsoTimestamp(now())
  const jobs = createJobRunner({ ...options.jobs, now, db: options.db, handlers })
  const events = createEvents(jobs, handlers)
  const mail = createMailService(options.db, settings, jobs, options.mailTransport)
  handlers.set(MAIL_JOB, mail.handler)
  const { handler: updateHandler, ...updates } = createUpdates({ ...options, settings, now })
  handlers.set(UPDATE_CHECK_JOB, updateHandler)
  const leaseMs = options.textureClaimLeaseMs ?? 600_000
  const files = createTextureFiles({
    db: options.db,
    storage: options.textureStorage,
    renders,
    jobs,
    now,
    leaseMs,
    deleteDelayMs: options.textureDeleteDelayMs ?? 3_600_000,
    attemptLeaseMs: options.textureDeleteAttemptLeaseMs,
  })
  for (const [name, handler] of Object.entries(files.handlers)) handlers.set(name, handler)
  handlers.set(AUTH_CLEANUP_JOB, createAuthCleanup({ db: options.db, now }))
  for (const [name, handler] of Object.entries(createNotificationJobs({ db: options.db, jobs, settings, now })))
    handlers.set(name, handler)
  handlers.set(AUDIT_CLEANUP_JOB, createAuditCleanup({ db: options.db, settings, now }))
  handlers.set(
    TEXTURE_SWEEP_JOB,
    createTextureSweep({
      db: options.db,
      storage: options.textureStorage,
      files,
      jobs,
      now,
      leaseMs,
      logger: options.jobs?.logger,
    }),
  )
  handlers.set(
    SITE_IMAGE_SWEEP_JOB,
    createSiteImageSweep({ storage: siteImages, settings, now, logger: options.jobs?.logger }),
  )
  const schedules = createScheduler({
    db: options.db,
    jobs,
    handlers,
    now,
    logger: options.jobs?.logger,
    timeZone: async () => (await settings.read(['site.timeZone']))['site.timeZone'],
  })
  const pluginDb = createPluginDbGateway({
    db: options.db,
    sqliteFile: options.plugins?.sqliteFile,
    logger: options.plugins?.logger,
  })
  const plugins = createPluginSystem({
    db: options.db,
    dialect: dialectOf(options.db),
    secretKey: options.secretKey,
    settings,
    jobs,
    handlers,
    events,
    schedules,
    storage: options.textureStorage,
    gateway: pluginDb,
    official: options.plugins?.official ?? [],
    now,
    syncIntervalMs: options.plugins?.syncIntervalMs,
    logger: options.plugins?.logger,
    load: options.plugins?.load,
    host: options.plugins?.host ?? null,
    hostMode: options.plugins?.hostMode,
    packages: options.plugins?.packages ?? null,
    hostRestart: options.plugins?.hostRestart,
    fetch: options.plugins?.fetch,
  })
  handlers.set(PLUGIN_KV_CLEANUP_JOB, { run: () => plugins.kv.cleanup() })
  handlers.set(PLUGIN_CLEANUP_JOB, { run: ({ payload }) => plugins.cleanupUninstalled(payload) })
  schedules.add({ name: PLUGIN_KV_CLEANUP_JOB, job: PLUGIN_KV_CLEANUP_JOB, cron: '37 4 * * *' })
  schedules.add({ name: UPDATE_CHECK_JOB, job: UPDATE_CHECK_JOB, cron: '43 5 * * *' })
  schedules.add({ name: AUTH_CLEANUP_JOB, job: AUTH_CLEANUP_JOB, cron: '17 4 * * *' })
  schedules.add({ name: NOTIFICATION_SWEEP_JOB, job: NOTIFICATION_SWEEP_JOB, cron: '32 4 * * *' })
  schedules.add({ name: AUDIT_CLEANUP_JOB, job: AUDIT_CLEANUP_JOB, cron: '27 4 * * *' })
  schedules.add({ name: TEXTURE_SWEEP_JOB, job: TEXTURE_SWEEP_JOB, cron: '47 4 * * 0' })
  schedules.add({ name: SITE_IMAGE_SWEEP_JOB, job: SITE_IMAGE_SWEEP_JOB, cron: '57 4 * * 0' })
  const removal = createTextureRemoval(events, files)
  const textureOptions = {
    interceptUserAction: plugins.interceptUserAction,
    db: options.db,
    settings,
    events,
    files,
    storage: options.textureStorage,
    imagePool,
    renders,
    removal,
    now,
  }
  // 哈希既不是当前算法、也不是 BS 旧格式时交给 passwordHasher 插件：网页登录、启动器登录和敏感操作前的核对密码（ADR-0033）
  const passwordPlugins = (input: { hash: string; password: string }) => plugins.verifyPassword(input)
  const auth = createAuthService({
    db: options.db,
    secretKey: options.secretKey,
    settings,
    production: options.production,
    mail,
    captcha,
    passwordPlugins,
    interceptIssueToken: plugins.interceptIssueToken,
    onPasswordChanged: async (uid) => {
      // 吊销启动器和 OAuth 凭据单独提交：事件入队失败会回滚它所在的事务，而改密码已经成功了（ADR-0030）
      await transactionWithRetry(options.db, async (tx) => {
        await tx
          .updateTable('users')
          .set((eb) => ({ role: eb.ref('role') }))
          .where('id', '=', uid)
          .execute()
        await deleteLauncherTokens(tx, uid)
        await deleteOAuthTokensForUser(tx, uid)
        await deleteClaimedDeviceCodes(tx, uid)
      })
      await transactionWithRetry(options.db, async (tx) => {
        const user = await tx.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
        if (user)
          await events.emit(
            tx,
            'user.profileUpdated',
            { kind: 'user', uid, role: user.role },
            { uid, fields: ['password'] },
            toIsoTimestamp(now()),
          )
      })
    },
  })
  const register = createRegister(options.db, settings, auth, mail, events, plugins)
  // 第三方登录（ADR-0034）：首次登录经过注册用例，user.register 拦截器和注册表单的插件字段照样生效
  const externalLogin = createExternalLogin({ db: options.db, settings, plugins, mail, jobs, register, now })
  const getSigningKey = createSigningKeyQuery(settings)
  const players = {
    ...createPlayerQueries(options.db),
    ...createPlayerManagement(options.db, settings, events, now, plugins.interceptUserAction),
  }
  const closet = createCloset(textureOptions)
  const upload = createTextureUpload(textureOptions)
  const tokens = createTokens({
    db: options.db,
    settings,
    secretKey: options.secretKey,
    now,
    passwordPlugins,
    interceptIssueToken: plugins.interceptIssueToken,
  })
  const yggdrasil = {
    getSigningKey,
    ...tokens.service,
    ...createSessions({
      db: options.db,
      tokens,
      events,
      now,
      cache: options.yggdrasilSessionCache ?? createMemorySessionCache(now),
    }),
    ...createProfileTextures({ db: options.db, settings, tokens, upload, closet, players }),
  }
  return {
    diagnostics: createDiagnostics({
      db: options.db,
      secretKey: options.secretKey,
      now,
      startedAt,
      plugins,
      updates,
      version: options.release?.version,
      dataDirectory: options.dataDirectory ?? resolve('data'),
      instanceDirectory: options.instanceDirectory ?? resolve('.'),
      runMode: options.runMode ?? (options.production ? 'direct' : 'development'),
      envNames: options.envNames ?? [],
      fileLogging: options.fileLogging ?? false,
    }),
    updates,
    themes: createThemes({ db: options.db, settings, plugins, secretKey: options.secretKey, now }),
    customCode: createCustomCode(settings),
    home: createHomeQueries(options.db, settings, now),
    players,
    setup: createSetup({
      db: options.db,
      secretKey: options.secretKey,
      file: options.setupCodeFile ?? null,
      settings,
      events,
      now,
    }),
    admin: createAdmin({
      ...textureOptions,
      secretKey: options.secretKey,
      production: options.production,
      mail,
      jobs,
      handlers,
      plugins,
      getSigningKey,
      captcha,
      siteImages,
    }),
    closet,
    reports: createReports(textureOptions),
    notifications: createNotifications({ db: options.db, plugins, now }),
    renders,
    plugins: Object.assign(plugins, {
      admin: createPluginAdmin({ db: options.db, plugins, externalLogin, secretKey: options.secretKey, now }),
      references: (input: Parameters<typeof pluginReferences>[1]) => pluginReferences(options.db, input),
    }),
    async shutdown() {
      await plugins.stop()
      await pluginDb.close()
      await imagePool.close()
    },
    textures: {
      ...createTextureQueries(options.db, options.textureStorage),
      ...createTextureLibraryQueries(options.db, settings),
      upload,
      ...createTextureManagement(textureOptions),
    },
    settings,
    /** 站点图片的公开地址 `/site-images/<文件>`：文件名不对、文件不在时返回 null */
    siteImages: {
      read: (file: string) => (isSiteImageFile(file) ? siteImages.read(file) : Promise.resolve(null)),
    },
    captcha,
    auth,
    externalLogin,
    mail,
    jobs,
    schedules,
    events: { subscribe: events.subscribe },
    users: {
      register,
      checkIn: createCheckIn(options.db, settings),
      ...createUserQueries(options.db, settings),
      ...createUserManagement(options, settings, mail, jobs, events, removal, now, passwordPlugins),
    },
    score: createScoreQueries(options.db),
    oauth: {
      ...createOAuthClients({ db: options.db, settings, now, interceptUserAction: plugins.interceptUserAction }),
      ...createDevices({ db: options.db, settings, now }),
      ...createAuthorizations({ db: options.db, now }),
    },
    yggdrasil,
  }
}

export type Core = ReturnType<typeof createCore>
