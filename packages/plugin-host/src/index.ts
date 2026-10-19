// 插件侧运行时：官方插件在核心进程内用它，安装插件在 plugin host 进程里用它（ADR-0009、ADR-0033）。
export { remoteDialect, NO_TRANSACTIONS, type CoreDialect, type PluginDbRpc } from './remote-dialect.ts'
export {
  buildManifest,
  describePlugin,
  PluginDefinitionError,
  PLUGIN_API_VERSION,
  pluginApiRange,
  PLUGIN_ID,
  OBJECT_NAME,
  type AnyPluginDefinition,
  type PluginContributions,
  type PluginPackageJson,
} from './manifest.ts'
export { eventNames } from './events.ts'
export { translatePlugin, type PluginMessages } from './messages.ts'
export {
  BodyTooLargeError,
  readBody,
  serializeRequest,
  deserializeRequest,
  serializeResponse,
  deserializeResponse,
} from './http.ts'
export {
  loadPlugin,
  PluginSettingsInvalidError,
  PluginTimeoutError,
  MAX_FETCH_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  type LoadedPlugin,
} from './runtime.ts'
export type {
  CoreMethod,
  CoreRequests,
  CoreRpc,
  CoreToHost,
  HostLoadResult,
  HostPluginSpec,
  HostToCore,
  InterceptOutcome,
  InvocationContext,
  PluginCall,
  SerializedRequest,
  SerializedResponse,
  WireError,
} from './protocol.ts'
export { pluginHostEntry } from './entry.ts'
export {
  ChannelBackpressureError,
  ChannelClosedError,
  createFrameChannel,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  type FrameChannel,
} from './channel.ts'
export * from './package/semver.ts'
export * from './package/tar.ts'
export * from './package/archive.ts'
export * from './package/manifest-schema.ts'
export * from './package/module-loader.ts'
