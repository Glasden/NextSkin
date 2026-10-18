import { createScheduler } from './jobs/schedules.ts'
import { AUTH_CLEANUP_JOB, createAuthCleanup } from './auth/cleanup.ts'
import { AUDIT_CLEANUP_JOB, createAuditCleanup } from './audit/cleanup.ts'
import { TEXTURE_SWEEP_JOB, createTextureSweep } from './textures/sweep.ts'
import { createAdmin } from './admin/service.ts'
import { createCloset } from './closet/service.ts'
import { createReports } from './reports/service.ts'
import { toIsoTimestamp, transactionWithRetry, type CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { createAuthService } from './auth/service.ts'
import { createEvents } from './events/emit.ts'
import { createJobRunner, type JobHandler, type JobRunnerOptions } from './jobs/runner.ts'
import { createMailService, MAIL_JOB } from './mail/service.ts'
import type { MailTransport } from './mail/types.ts'
import { createPlayerManagement } from './players/manage.ts'
import { createCheckIn } from './users/check-in.ts'
import { createUserManagement } from './users/manage.ts'
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

export interface CoreOptions {
  db: Kysely<CoreDatabase>
  textureStorage: TextureStorage
  /** 材质用例与任务共享的时钟；同时供任务执行器入队和轮询使用。 */
  now?: () => Date
  textureClaimLeaseMs?: number
  textureDeleteDelayMs?: number
  /** 删除尝试的租期，默认 10 分钟，应远大于回收任务的超时。 */
  textureDeleteAttemptLeaseMs?: number
  renderCache?: RenderCache
  imagePool?: ImagePool
  /** .env 里的密钥，用来解密机密设置；至少 32 个字符。 */
  secretKey: string
  /** 生产环境：站点地址必须在设置里填写（auth/service.ts） */
  production: boolean
  mailTransport?: MailTransport
  /** 任务执行器的参数，测试用来控制时钟和轮询 */
  jobs?: Omit<JobRunnerOptions, 'db' | 'handlers'>
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
  // 执行器每次轮询都读这张表，事件订阅和核心任务往里登记处理函数
  const handlers = new Map<string, JobHandler>()
  const now = options.now ?? options.jobs?.now ?? (() => new Date())
  const jobs = createJobRunner({ ...options.jobs, now, db: options.db, handlers })
  const events = createEvents(jobs, handlers)
  const mail = createMailService(options.db, settings, jobs, options.mailTransport)
  handlers.set(MAIL_JOB, mail.handler)
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
      log: options.jobs?.log,
    }),
  )
  const schedules = createScheduler({
    db: options.db,
    jobs,
    handlers,
    now,
    log: options.jobs?.log,
    timeZone: async () => (await settings.read(['site.timeZone']))['site.timeZone'],
  })
  schedules.add({ name: AUTH_CLEANUP_JOB, job: AUTH_CLEANUP_JOB, cron: '17 4 * * *' })
  schedules.add({ name: AUDIT_CLEANUP_JOB, job: AUDIT_CLEANUP_JOB, cron: '27 4 * * *' })
  schedules.add({ name: TEXTURE_SWEEP_JOB, job: TEXTURE_SWEEP_JOB, cron: '47 4 * * 0' })
  const removal = createTextureRemoval(events, files)
  const textureOptions = {
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
  const auth = createAuthService({
    db: options.db,
    secretKey: options.secretKey,
    settings,
    production: options.production,
    mail,
    onPasswordChanged: (uid) =>
      transactionWithRetry(options.db, async (tx) => {
        const user = await tx.selectFrom('users').select('role').where('id', '=', uid).executeTakeFirst()
        if (user)
          await events.emit(
            tx,
            'user.profileUpdated',
            { kind: 'user', uid, role: user.role },
            { uid, fields: ['password'] },
            toIsoTimestamp(new Date()),
          )
      }),
  })
  const getSigningKey = createSigningKeyQuery(settings)
  return {
    players: { ...createPlayerQueries(options.db), ...createPlayerManagement(options.db, settings, events, now) },
    admin: createAdmin({
      ...textureOptions,
      secretKey: options.secretKey,
      production: options.production,
      mail,
      getSigningKey,
    }),
    closet: createCloset(textureOptions),
    reports: createReports(textureOptions),
    renders,
    shutdown: () => imagePool.close(),
    textures: {
      ...createTextureQueries(options.db, options.textureStorage),
      ...createTextureLibraryQueries(options.db, settings),
      upload: createTextureUpload(textureOptions),
      ...createTextureManagement(textureOptions),
    },
    settings,
    auth,
    mail,
    jobs,
    schedules,
    events: { subscribe: events.subscribe },
    users: {
      register: createRegister(options.db, settings, auth, mail, events),
      checkIn: createCheckIn(options.db, settings),
      ...createUserQueries(options.db, settings),
      ...createUserManagement(options, settings, mail, jobs, events, removal, now),
    },
    score: createScoreQueries(options.db),
    yggdrasil: { getSigningKey },
  }
}

export type Core = ReturnType<typeof createCore>
