import type { CoreDatabase } from '@nextskin/db'
import type { Kysely } from 'kysely'
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
}

export function createCore(options: CoreOptions) {
  validateSecretKey(options.secretKey)
  const settings = createSettingQueries(options.db, options.secretKey)
  return {
    players: createPlayerQueries(options.db),
    textures: createTextureQueries(options.db, options.textureStorage),
    settings,
    yggdrasil: { getSigningKey: createSigningKeyQuery(settings) },
  }
}

export type Core = ReturnType<typeof createCore>
