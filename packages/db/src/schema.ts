import type { ColumnType, Generated } from 'kysely'
import type { IsoTimestamp, SwitchValue } from './helpers.ts'

export type UserRole = 'banned' | 'user' | 'admin' | 'superadmin'
export type TextureType = 'steve' | 'alex' | 'cape'
export type TextureFileStatus = 'pending' | 'active' | 'deleting'

export interface UsersTable {
  id: Generated<number>
  nickname: string
  email: string
  email_verified: ColumnType<boolean | number, boolean, boolean>
  image: string | null
  two_factor_enabled: ColumnType<boolean | number | null, boolean | null | undefined, boolean | null>
  created_at: ColumnType<Date | string, Date | string, Date | string>
  updated_at: ColumnType<Date | string, Date | string, Date | string>
  role: Generated<UserRole>
  score: Generated<number>
  avatar_texture_id: number | null
  locale: string | null
  registration_ip: string | null
  last_check_in_at: IsoTimestamp | null
}

export interface TextureFilesTable {
  hash: string
  pixel_hash: string | null
  width: number | null
  height: number | null
  size_bytes: number | null
  ref_count: number
  status: TextureFileStatus
  claim_id: string | null
  status_changed_at: IsoTimestamp
  delete_attempted_at: IsoTimestamp | null
  delete_confirmed_at: IsoTimestamp | null
  created_at: IsoTimestamp
}

export interface TexturesTable {
  id: Generated<number>
  hash: string
  name: string
  type: TextureType
  description: string | null
  uploader_id: number | null
  is_public: SwitchValue
  likes: Generated<number>
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

export interface PlayersTable {
  id: Generated<number>
  user_id: number
  name: string
  name_key: string
  uuid: string
  skin_texture_id: number | null
  cape_texture_id: number | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

export interface SettingsTable {
  namespace: string
  key: string
  value: string
  updated_at: IsoTimestamp
}

export interface CoreDatabase {
  users: UsersTable
  texture_files: TextureFilesTable
  textures: TexturesTable
  players: PlayersTable
  settings: SettingsTable
}
