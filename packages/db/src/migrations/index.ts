import type { Migration } from 'kysely/migration'
import * as createUsers from './0001_create_users.ts'
import * as createTextureFiles from './0002_create_texture_files.ts'
import * as createTextures from './0003_create_textures.ts'
import * as addUsersAvatarTextureId from './0004_add_users_avatar_texture_id.ts'
import * as createPlayers from './0005_create_players.ts'
import * as createSettings from './0006_create_settings.ts'

export const coreMigrations: Record<string, Migration> = {
  '0001_create_users': createUsers,
  '0002_create_texture_files': createTextureFiles,
  '0003_create_textures': createTextures,
  '0004_add_users_avatar_texture_id': addUsersAvatarTextureId,
  '0005_create_players': createPlayers,
  '0006_create_settings': createSettings,
}
