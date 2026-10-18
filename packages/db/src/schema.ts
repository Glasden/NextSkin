import type { ColumnType, Generated } from 'kysely'
import type { IsoTimestamp, SwitchValue } from './helpers.ts'

export type UserRole = 'banned' | 'user' | 'admin' | 'superadmin'
export type TextureType = 'steve' | 'alex' | 'cape'
export type TextureFileStatus = 'pending' | 'active' | 'deleting'

export interface UsersTable {
  id: Generated<number>
  nickname: string
  email: string
  email_version: Generated<number>
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
  score_paid: Generated<number>
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

export interface ClosetItemsTable {
  user_id: number
  texture_id: number
  name: string
  score_paid: Generated<number>
  created_at: IsoTimestamp
}

export interface AuditLogsTable {
  id: Generated<number>
  actor_type: 'user' | 'system' | 'plugin'
  actor_user_id: number | null
  actor_plugin_id: string | null
  action: string
  subject_type: string
  subject_id: number
  details: string
  ip: string | null
  created_at: IsoTimestamp
}

export interface ReportsTable {
  id: Generated<number>
  texture_id: number | null
  uploader_id: number | null
  reporter_id: number | null
  reason: string
  score_paid: Generated<number>
  status: 'pending' | 'resolved' | 'rejected'
  resolution: 'dismissed' | 'textureDeleted' | 'uploaderBanned' | null
  resolver_id: number | null
  created_at: IsoTimestamp
  resolved_at: IsoTimestamp | null
}

export interface PlayersTable {
  score_paid: Generated<number>
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

export interface SessionsTable {
  id: Generated<number>
  expires_at: ColumnType<Date | string, Date | string, Date | string>
  token: string
  created_at: ColumnType<Date | string, Date | string, Date | string>
  updated_at: ColumnType<Date | string, Date | string, Date | string>
  ip_address: string | null
  user_agent: string | null
  user_id: number
}

export interface AccountsTable {
  id: Generated<number>
  account_id: string
  provider_id: string
  user_id: number
  access_token: string | null
  refresh_token: string | null
  id_token: string | null
  access_token_expires_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  refresh_token_expires_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  scope: string | null
  password: string | null
  created_at: ColumnType<Date | string, Date | string, Date | string>
  updated_at: ColumnType<Date | string, Date | string, Date | string>
}

export interface VerificationsTable {
  id: Generated<number>
  identifier: string
  value: string
  expires_at: ColumnType<Date | string, Date | string, Date | string>
  created_at: ColumnType<Date | string, Date | string, Date | string>
  updated_at: ColumnType<Date | string, Date | string, Date | string>
}

export interface JwksTable {
  id: Generated<number>
  public_key: string
  private_key: string
  created_at: ColumnType<Date | string, Date | string, Date | string>
  expires_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  alg: string | null
  crv: string | null
}

export interface OAuthClientsTable {
  id: Generated<number>
  client_id: string
  client_secret: string | null
  client_discovery_id: string | null
  disabled: ColumnType<boolean | number | null, boolean | null, boolean | null>
  skip_consent: ColumnType<boolean | number | null, boolean | null, boolean | null>
  enable_end_session: ColumnType<boolean | number | null, boolean | null, boolean | null>
  subject_type: string | null
  scopes: ColumnType<unknown, string | null, string | null>
  client_credentials_scopes: ColumnType<unknown, string | null, string | null>
  user_id: number | null
  created_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  updated_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  name: string | null
  uri: string | null
  icon: string | null
  contacts: ColumnType<unknown, string | null, string | null>
  tos: string | null
  policy: string | null
  software_id: string | null
  software_version: string | null
  software_statement: string | null
  redirect_uris: ColumnType<unknown, string, string>
  post_logout_redirect_uris: ColumnType<unknown, string | null, string | null>
  backchannel_logout_uri: string | null
  backchannel_logout_session_required: ColumnType<boolean | number | null, boolean | null, boolean | null>
  token_endpoint_auth_method: string | null
  application_type: string | null
  jwks: string | null
  jwks_uri: string | null
  grant_types: ColumnType<unknown, string | null, string | null>
  response_types: ColumnType<unknown, string | null, string | null>
  require_pkce: ColumnType<boolean | number | null, boolean | null, boolean | null>
  dpop_bound_access_tokens: ColumnType<boolean | number | null, boolean | null, boolean | null>
  reference_id: string | null
  metadata: ColumnType<unknown, string | null, string | null>
}

export interface OAuthResourcesTable {
  id: Generated<number>
  identifier: string
  name: string
  access_token_ttl: number | null
  refresh_token_ttl: number | null
  signing_algorithm: string | null
  signing_key_id: string | null
  allowed_scopes: ColumnType<unknown, string | null, string | null>
  custom_claims: ColumnType<unknown, string | null, string | null>
  dpop_bound_access_tokens_required: ColumnType<boolean | number | null, boolean | null, boolean | null>
  disabled: ColumnType<boolean | number | null, boolean | null, boolean | null>
  created_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  updated_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  policy_version: number | null
  metadata: ColumnType<unknown, string | null, string | null>
}

export interface OAuthClientResourcesTable {
  id: Generated<number>
  client_id: string
  resource_id: string
  metadata: ColumnType<unknown, string | null, string | null>
  created_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
}

export interface OAuthRefreshTokensTable {
  id: Generated<number>
  token: string
  client_id: string
  session_id: number | null
  user_id: number
  reference_id: string | null
  authorization_code_id: string | null
  resources: ColumnType<unknown, string | null, string | null>
  requested_user_info_claims: ColumnType<unknown, string | null, string | null>
  expires_at: ColumnType<Date | string, Date | string, Date | string>
  created_at: ColumnType<Date | string, Date | string, Date | string>
  revoked: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  rotated_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  rotation_replay_response: string | null
  rotation_replay_expires_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  auth_time: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  confirmation: ColumnType<unknown, string | null, string | null>
  scopes: ColumnType<unknown, string, string>
}

export interface OAuthAccessTokensTable {
  id: Generated<number>
  token: string
  client_id: string
  session_id: number | null
  user_id: number | null
  reference_id: string | null
  authorization_code_id: string | null
  resources: ColumnType<unknown, string | null, string | null>
  requested_user_info_claims: ColumnType<unknown, string | null, string | null>
  refresh_id: number | null
  expires_at: ColumnType<Date | string, Date | string, Date | string>
  created_at: ColumnType<Date | string, Date | string, Date | string>
  revoked: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  confirmation: ColumnType<unknown, string | null, string | null>
  scopes: ColumnType<unknown, string, string>
}

export interface OAuthConsentsTable {
  id: Generated<number>
  client_id: string
  user_id: number | null
  reference_id: string | null
  resources: ColumnType<unknown, string | null, string | null>
  requested_user_info_claims: ColumnType<unknown, string | null, string | null>
  scopes: ColumnType<unknown, string, string>
  created_at: ColumnType<Date | string, Date | string, Date | string>
  updated_at: ColumnType<Date | string, Date | string, Date | string>
}

export interface OAuthClientAssertionsTable {
  id: Generated<number>
  expires_at: ColumnType<Date | string, Date | string, Date | string>
}

export interface DeviceCodesTable {
  id: Generated<number>
  device_code: string
  user_code: string
  user_id: string | null
  expires_at: ColumnType<Date | string, Date | string, Date | string>
  status: string
  last_polled_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  polling_interval: number | null
  client_id: string | null
  scope: string | null
  resources: ColumnType<unknown, string | null, string | null>
  oauth_client_id: string | null
}

export interface TwoFactorsTable {
  id: Generated<number>
  secret: string
  backup_codes: string
  user_id: number
  verified: ColumnType<boolean | number | null, boolean | null, boolean | null>
  failed_verification_count: number | null
  locked_until: ColumnType<Date | string | null, Date | string | null, Date | string | null>
}

export interface PasskeysTable {
  id: Generated<number>
  name: string | null
  public_key: string
  user_id: number
  credential_id: string
  counter: number
  device_type: string
  backed_up: ColumnType<boolean | number, boolean, boolean>
  transports: string | null
  created_at: ColumnType<Date | string | null, Date | string | null, Date | string | null>
  aaguid: string | null
}

export interface DeviceCodeSelectionsTable {
  device_code: string
  user_id: number
  player_id: number
  created_at: IsoTimestamp
}

export interface JobSchedulesTable {
  name: string
  cron: string
  time_zone: string
  next_run_at: IsoTimestamp
}

export interface JobsTable {
  id: Generated<number>
  name: string
  payload: string
  dedupe_key: string | null
  run_at: IsoTimestamp
  lease_id: string | null
  attempts: Generated<number>
  last_error: string | null
  created_at: IsoTimestamp
}

export interface FailedJobsTable {
  id: Generated<number>
  name: string
  payload: string
  dedupe_key: string | null
  attempts: number
  last_error: string | null
  created_at: IsoTimestamp
  failed_at: IsoTimestamp
}

export interface ScoreTransactionsTable {
  id: Generated<number>
  user_id: number
  delta: number
  balance: number
  reason: string
  subject_type: string | null
  subject_id: number | null
  created_at: IsoTimestamp
}

export interface YggdrasilTokensTable {
  id: Generated<number>
  access_token_hash: string
  client_token: string
  user_id: number
  player_id: number | null
  created_at: IsoTimestamp
  valid_until: IsoTimestamp
  expires_at: IsoTimestamp
}

export type ImportRunStatus = 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled'
export type ImportRunEntry = 'setup' | 'admin' | 'cli'

export interface ImportRunsTable {
  id: Generated<number>
  status: ImportRunStatus
  is_dry_run: SwitchValue
  entry: ImportRunEntry
  started_by: string | null
  source: string
  report: string | null
  started_at: IsoTimestamp
  finished_at: IsoTimestamp | null
}

export interface PluginsTable {
  id: string
  version: string
  is_enabled: SwitchValue
  /** 管理员授予的能力，JSON 字符串数组 */
  capabilities: string
  package_hash: string | null
  last_error: string | null
  installed_at: IsoTimestamp
  updated_at: IsoTimestamp
}

export interface PluginKvTable {
  plugin_id: string
  key: string
  value: string
  expires_at: IsoTimestamp | null
  updated_at: IsoTimestamp
}

export interface PluginMigrationsTable {
  plugin_id: string
  name: string
  executed_at: IsoTimestamp
}

export interface CoreDatabase {
  plugins: PluginsTable
  plugin_kv: PluginKvTable
  plugin_migrations: PluginMigrationsTable
  import_runs: ImportRunsTable
  yggdrasil_tokens: YggdrasilTokensTable
  job_schedules: JobSchedulesTable
  jobs: JobsTable
  failed_jobs: FailedJobsTable
  score_transactions: ScoreTransactionsTable
  users: UsersTable
  texture_files: TextureFilesTable
  audit_logs: AuditLogsTable
  reports: ReportsTable
  closet_items: ClosetItemsTable
  textures: TexturesTable
  players: PlayersTable
  settings: SettingsTable
  sessions: SessionsTable
  accounts: AccountsTable
  verifications: VerificationsTable
  jwks: JwksTable
  oauth_clients: OAuthClientsTable
  oauth_resources: OAuthResourcesTable
  oauth_client_resources: OAuthClientResourcesTable
  oauth_refresh_tokens: OAuthRefreshTokensTable
  oauth_access_tokens: OAuthAccessTokensTable
  oauth_consents: OAuthConsentsTable
  oauth_client_assertions: OAuthClientAssertionsTable
  device_codes: DeviceCodesTable
  two_factors: TwoFactorsTable
  passkeys: PasskeysTable
  device_code_selections: DeviceCodeSelectionsTable
}
