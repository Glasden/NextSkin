export type PluginPackageErrorCode =
  | 'too_large'
  | 'invalid_archive'
  | 'unsupported_entry'
  | 'invalid_path'
  | 'duplicate_path'
  | 'too_many_files'
  | 'missing_manifest'
  | 'invalid_manifest'
  | 'missing_entry'
  | 'integrity_mismatch'
  | 'invalid_locale'
  | 'locales_too_large'

/** 包格式错误；消息面向插件作者，不包含本机路径。 */
export class PluginPackageError extends Error {
  override name = 'PluginPackageError'
  readonly code: PluginPackageErrorCode

  constructor(code: PluginPackageErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
