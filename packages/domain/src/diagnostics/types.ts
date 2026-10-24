import type { DatabaseDialect, IsoTimestamp } from '@nextskin/db'
import type { PluginHostStatus } from '../plugins/system.ts'
import type { ManagerStatus } from '../updates/manager-client.ts'

export interface DiagnosticsRuntime {
  runMode: 'manager' | 'launcher' | 'direct' | 'development'
  envNames: string[]
  instanceDirectory: string
  fileLogging: boolean
}
export interface DiagnosticsSummary {
  versions: { nextskin: string | null; pluginApi: string; node: string; os: string; arch: string }
  runMode: DiagnosticsRuntime['runMode']
  /** 这份摘要是什么时候读的；页面据此算已运行和等了多久，渲染不读时钟 */
  generatedAt: IsoTimestamp
  startedAt: IsoTimestamp
  database: {
    dialect: DatabaseDialect
    serverVersion: string | null
    pendingCore: number
    unknownCore: number
    pendingPlugins: { plugin: string; migrations: number }[]
  }
  storage: {
    dataDirectory: string
    freeBytes: number | null
    totalBytes: number | null
    fileLogging: boolean
    logBytes: number
    logFiles: number
    droppedRecently: number | null
    /** false：只扫了最新的 8 MB，还没到 24 小时以前，droppedRecently 是下限 */
    droppedComplete: boolean
  }
  pluginHost: PluginHostStatus
  jobs: { queued: number; oldestDueAt: IsoTimestamp | null; deadLetters: number }
  lastUpdate: ManagerStatus['lastResult'] | null
}
