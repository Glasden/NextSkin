// 领域用例与查询服务，按业务领域分目录（players、textures、settings、yggdrasil……）。
// 写操作只能经过这里的用例：在一个事务内完成状态变更、触发拦截器、把事件写入 outbox（ADR-0004）。
export { createCore, type Core, type CoreOptions } from './core.ts'
export { DomainError } from './errors.ts'
export { phpTrim } from './text.ts'
export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './auth/password-policy.ts'
export { resolveClientIp } from './network/client-ip.ts'
export { assertEmailVerified } from './users/email-verification.ts'
export type { RegisterInput } from './users/register.ts'
export type { MailMessage, MailTransport } from './mail/types.ts'
export { openCore, migrateCore } from './bootstrap.ts'
export { MigrationBackupError } from '@nextskin/db'
export { coreConfigFromEnv, type CoreConfig } from './config.ts'
export { toNameKey, normalizeNameLookup, normalizeUuidLookup, type PlayerView } from './players/queries.ts'
export { createLocalTextureStorage, type TextureStorage } from './textures/storage.ts'
export { encodeSettingValue } from './settings/codec.ts'
export {
  settingSections,
  type SettingSection,
  coreSettingsRegistry,
  coreSettingsNamespace,
  type CoreSettingKey,
  type CoreSettingValue,
  type CoreSettings,
} from './settings/registry.ts'
export type { SigningKey } from './yggdrasil/signing-key.ts'

export type { SessionUser, ConsentRequestView } from './auth/service.ts'
export {
  EXTERNAL_PENDING_TTL_SECONDS,
  EXTERNAL_STATE_TTL_SECONDS,
  externalCallbackPath,
  type ExternalCallbackResult,
} from './auth/external-login.ts'
export type { UserActor } from './users/lock.ts'
export type { CheckInRules, CheckInResult } from './users/check-in.ts'
export type { UserOverview } from './users/queries.ts'
export type { OwnedPlayer } from './players/queries.ts'
export type { ScoreEntry } from './score/queries.ts'
export type { Player } from '@nextskin/plugin-sdk'
export type { UserRole, TextureType } from '@nextskin/db'
export type { IsoTimestamp } from '@nextskin/db'

export type { ChangeEmailResult } from './users/manage.ts'
export type { PrivateUser } from '@nextskin/plugin-sdk'

export { RENDERER_VERSION } from '@nextskin/skin'
export { createImagePool, type ImagePool } from './textures/image-pool.ts'
export {
  createMemoryRenderCache,
  createLocalRenderCache,
  type RenderCache,
  type RenderKey,
} from './textures/render-cache.ts'

export type { Texture } from './dto.ts'
export type { TextureSummary, TextureDetail, TextureListInput } from './textures/queries.ts'

export type { ClosetItem } from './closet/service.ts'
export type { Report, OwnReport } from './reports/service.ts'

export { can, hasAdminAccess, outranks, type CorePermission } from './access/permissions.ts'
export type {
  AdminActor,
  AdminOAuthClient,
  ReportAction,
  AssignableRole,
  AdminReport,
  AdminUser,
  AuditEntry,
  AdminOverview,
  AdminUserUpdate,
  AdminEmailChangeResult,
  RevokedLogins,
  AdminSetPasswordInput,
  PublicTexturesOnDelete,
  AdminUserDetail,
  AdminHiddenTexture,
  AdminPlayer,
  AdminPlayerUpdate,
  AdminUserLookup,
  AdminTextureForOwner,
  AdminClosetItem,
} from './admin/types.ts'
export { AUDIT_ACTIONS, type AuditAction } from './audit/write.ts'

export { settingControl, settingJsonSchema, type SettingControl, type JsonSchema } from './settings/form.ts'
export type { SettingView } from './admin/settings.ts'

export { YggdrasilError, type YggdrasilErrorKind } from './yggdrasil/errors.ts'
export type {
  AuthResponse,
  LauncherLogin,
  YggdrasilProfile,
  AuthenticateInput,
  RefreshInput,
  ValidateInput,
} from './yggdrasil/tokens.ts'
export type { CredentialsInput } from './yggdrasil/credentials.ts'
export type { JoinInput, HasJoinedInput } from './yggdrasil/join.ts'
export type {
  ResetTextureInput,
  UploadTextureInput as YggdrasilUploadTextureInput,
} from './yggdrasil/profile-textures.ts'
export { createMemorySessionCache, type YggdrasilSessionCache, type JoinSession } from './yggdrasil/sessions.ts'

export type { PodiumEntry, Podium, SiteStats } from './home/queries.ts'

export type { OfficialPlugin, PluginFormField, PluginHostStatus, PluginRouteRequest } from './plugins/system.ts'
export type { PluginSummary, PluginDetail, PluginScoreSummary, PluginPackagePreview } from './plugins/admin.ts'
export type { PluginHostEntry } from './plugins/host.ts'
export { hostNetworkRestricted, probePluginHost, HostStartError } from './plugins/host.ts'
export { pluginHostEntry } from '@nextskin/plugin-host'
export type { PluginSettingView } from './plugins/settings.ts'
export type { PluginReferences } from './plugins/references.ts'
/** 后台渲染插件声明的界面要用的类型（SDK 的 ui.ts） */
export type {
  Action as PluginAction,
  Column as PluginColumn,
  Field as PluginField,
  StatsSourceResponse as PluginStatsResponse,
  TableSourceResponse as PluginTableResponse,
  View as PluginView,
} from '@nextskin/plugin-sdk'
export type { DeadLetter } from './jobs/store.ts'
export { pluginFieldKey } from './plugins/form-fields.ts'
export { canPlugin } from './access/permissions.ts'

export type { OAuthClientSummary, DeviceCodeView } from './oauth/devices.ts'
export type { OAuthAuthorization } from './oauth/authorizations.ts'
export { OAUTH_SCOPES, SELECT_SCOPE, READ_SCOPE, JOIN_SCOPE, SHARED_OAUTH_CLIENT_ID } from './oauth/scopes.ts'

export type { OAuthClientType, OAuthClientView } from './oauth/clients.ts'

export { CAPTCHA_HEADER, type CaptchaPublicConfig, type CaptchaInput, type CaptchaResult } from './captcha/service.ts'
