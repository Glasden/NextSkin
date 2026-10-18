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
export { coreConfigFromEnv, openCore, type CoreConfig } from './bootstrap.ts'
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

export type { SessionUser } from './auth/service.ts'
export type { UserActor } from './users/lock.ts'
export type { CheckInRules, CheckInResult } from './users/check-in.ts'
export type { UserOverview } from './users/queries.ts'
export type { OwnedPlayer } from './players/queries.ts'
export type { ScoreEntry } from './score/queries.ts'
export type { Player, UserRole } from '@nextskin/plugin-sdk'
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

export type { Texture, TextureType } from '@nextskin/plugin-sdk'
export type { TextureSummary, TextureDetail, TextureListInput } from './textures/queries.ts'

export type { ClosetItem } from './closet/service.ts'
export type { Report, OwnReport } from './reports/service.ts'

export { can, hasAdminAccess, outranks, type CorePermission } from './access/permissions.ts'
export type {
  AdminActor,
  ReportAction,
  AssignableRole,
  AdminReport,
  AdminUser,
  AuditEntry,
  AdminOverview,
} from './admin/types.ts'

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
