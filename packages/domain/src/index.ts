// 领域用例与查询服务，按业务领域分目录（players、textures、settings、yggdrasil……）。
// 写操作只能经过这里的用例：在一个事务内完成状态变更、触发拦截器、把事件写入 outbox（ADR-0004）。
export { createCore, type Core, type CoreOptions } from './core.ts'
export { DomainError } from './errors.ts'
export { assertEmailVerified } from './users/email-verification.ts'
export type { RegisterInput } from './users/register.ts'
export type { MailMessage, MailTransport } from './mail/types.ts'
export { coreConfigFromEnv, openCore, type CoreConfig } from './bootstrap.ts'
export { toNameKey, normalizeNameLookup, normalizeUuidLookup, type PlayerView } from './players/queries.ts'
export { createLocalTextureStorage, type TextureStorage } from './textures/storage.ts'
export { encodeSettingValue } from './settings/codec.ts'
export {
  coreSettingsRegistry,
  coreSettingsNamespace,
  type CoreSettingKey,
  type CoreSettingValue,
  type CoreSettings,
} from './settings/registry.ts'
export type { SigningKey } from './yggdrasil/signing-key.ts'
