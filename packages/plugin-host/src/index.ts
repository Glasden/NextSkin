// 插件侧运行时：官方插件在核心进程内用它，安装插件在 plugin host 进程里用它（ADR-0009、ADR-0033）。
export { remoteDialect, NO_TRANSACTIONS, type CoreDialect, type PluginDbRpc } from './remote-dialect.ts'
