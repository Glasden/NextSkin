/**
 * 核心拒绝了插件的这次请求（能力不足、调用已结束、参数不对……）。
 * 消息原样交给插件，是给插件作者看的，不能带核心的内部信息。
 */
export class PluginCallRejected extends Error {
  override name = 'PluginCallRejected'
}

/**
 * 插件这次调用失败了：处理函数抛错、超时、返回值不对，或者插件暂时不可用。
 * `message` 是插件抛出的消息（截到 500 字符），只记进任务的 last_error 和后台，不返回给最终用户。
 */
export class PluginInvocationError extends Error {
  override name = 'PluginInvocationError'
  readonly pluginId: string
  readonly reason: 'error' | 'timeout' | 'invalid_result' | 'unavailable' | 'settings_invalid'
  constructor(pluginId: string, reason: PluginInvocationError['reason'], message: string) {
    super([...message].slice(0, 500).join(''))
    this.pluginId = pluginId
    this.reason = reason
  }
}
