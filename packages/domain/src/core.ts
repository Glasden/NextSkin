import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
import { createAuthService } from './auth/service.ts'
import { createMailService } from './mail/service.ts'
import type { MailTransport } from './mail/types.ts'
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
}

export function createCore(options: CoreOptions) {
  validateSecretKey(options.secretKey)
  const settings = createSettingQueries(options.db, options.secretKey)
  const mail = createMailService(options.db, settings, options.mailTransport)
  const auth = createAuthService({
    db: options.db,
    secretKey: options.secretKey,
    settings,
    production: options.production,
    mail,
  })
  return {
    players: createPlayerQueries(options.db),
    textures: createTextureQueries(options.db, options.textureStorage),
    settings,
    auth,
    mail,
    users: { register: createRegister(options.db, settings, auth, mail) },
    yggdrasil: { getSigningKey: createSigningKeyQuery(settings) },
  }
}

export type Core = ReturnType<typeof createCore>
