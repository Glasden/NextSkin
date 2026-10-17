import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { createAuthService } from './auth/service.ts'
import { createEvents } from './events/emit.ts'
import { createJobRunner, type JobHandler, type JobRunnerOptions } from './jobs/runner.ts'
import { createMailService, MAIL_JOB } from './mail/service.ts'
import type { MailTransport } from './mail/types.ts'
import { createPlayerManagement } from './players/manage.ts'
import { createCheckIn } from './users/check-in.ts'
import { createUserQueries } from './users/queries.ts'
import { createScoreQueries } from './score/queries.ts'
import { createRegister } from './users/register.ts'
import { createPlayerQueries } from './players/queries.ts'
import { validateSecretKey } from './settings/codec.ts'
import { createSettingQueries } from './settings/queries.ts'
import { createTextureQueries } from './textures/queries.ts'
import type { TextureStorage } from './textures/storage.ts'
import { createSigningKeyQuery } from './yggdrasil/signing-key.ts'

export interface CoreOptions {
  db: Kysely<CoreDatabase>
  textureStorage: TextureStorage
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
  const settings = createSettingQueries(options.db, options.secretKey)
  // 执行器每次轮询都读这张表，事件订阅和核心任务往里登记处理函数
  const handlers = new Map<string, JobHandler>()
  const jobs = createJobRunner({ ...options.jobs, db: options.db, handlers })
  const events = createEvents(jobs, handlers)
  const mail = createMailService(options.db, settings, jobs, options.mailTransport)
  handlers.set(MAIL_JOB, mail.handler)
  const auth = createAuthService({
    db: options.db,
    secretKey: options.secretKey,
    settings,
    production: options.production,
    mail,
  })
  return {
    players: { ...createPlayerQueries(options.db), ...createPlayerManagement(options.db, settings, events) },
    textures: createTextureQueries(options.db, options.textureStorage),
    settings,
    auth,
    mail,
    jobs,
    events: { subscribe: events.subscribe },
    users: {
      register: createRegister(options.db, settings, auth, mail, events),
      checkIn: createCheckIn(options.db, settings),
      ...createUserQueries(options.db, settings),
    },
    score: createScoreQueries(options.db),
    yggdrasil: { getSigningKey: createSigningKeyQuery(settings) },
  }
}

export type Core = ReturnType<typeof createCore>
