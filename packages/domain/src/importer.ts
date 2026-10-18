// 只给导入器（packages/importer）用的入口（ADR-0031）。导入器直接写表、不经过领域用例，是不变量 4 唯一的例外；
// 它从这里取领域层的编码规则（密码格式、名字规范化、UUID 算法、设置编码、像素 hash、材质存储），
// 写进库里的值才和用例写的一致。网页和 Hono 应用不要从这里导入
export { formatLegacyDigest, isLegacyPasswordHash, legacyDigestAlgorithm } from './auth/legacy-passwords.ts'
export type { LegacyDigestAlgorithm } from './auth/legacy-passwords.ts'
export { sha256 } from './auth/auth.ts'
export { offlineUuid } from './players/create.ts'
export { createPlayerQueries, toNameKey, type PlayerView } from './players/queries.ts'
export { encodeSettingValue } from './settings/codec.ts'
export {
  coreSettingsNamespace,
  coreSettingsRegistry,
  type CoreSettingKey,
  type CoreSettingValue,
} from './settings/registry.ts'
export { parseSigningKey } from './yggdrasil/signing-key.ts'
export { createImagePool, type ImagePool } from './textures/image-pool.ts'
export type { InspectedImage } from './textures/image.ts'
export { assertTextureHash, createLocalTextureStorage, type ImportableTextureStorage } from './textures/storage.ts'
export { DomainError } from './errors.ts'
export { coreConfigFromEnv, type CoreConfig } from './bootstrap.ts'
export { isLocale, matchLocale, type Locale } from '@nextskin/i18n'
