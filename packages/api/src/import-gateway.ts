// 网页导入服务的边界；Hono 不依赖导入器的实现或数据库（ADR-0031）。
export type SourceConnection =
  | { dialect: 'sqlite'; file: string }
  | { dialect: 'mysql' | 'postgres'; host: string; port: number; database: string; username: string; password: string }
export interface ImportSourceInput {
  connection: SourceConnection
  prefix: string
  texturesDirectory: string
  timeZone: string
  passwordMethod: string | null
  salt: string
}
export interface ImportStartInput extends ImportSourceInput {
  dryRun: boolean
  siteUrl: string | null
  uuidOverrides: Record<string, string>
  replace: boolean
  force: boolean
}
export interface ImportEnvForm {
  connection: SourceConnection | null
  prefix: string
  passwordMethod: string | null
  salt: string
  texturesDirectory: string | null
  localTextures: boolean
}
export type ImportRunStatus = 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled'
export interface ImportRunState {
  id: number | null
  entry: 'setup' | 'admin' | 'cli'
  dryRun: boolean
  status: ImportRunStatus
  cancelling: boolean
  progress: {
    stage: 'connect' | 'users' | 'textures' | 'players' | 'closet' | 'reports' | 'oauthClients' | 'settings' | 'commit'
    rows: number
    files: number
    total: number | null
  }
  startedAt: string
  finishedAt: string | null
  report: unknown
}
export interface ImportCheckResult {
  database:
    | {
        status: 'ok'
        bsVersion: string | null
        counts: { users: number; players: number; textures: number }
        uuidTable: 'yggdrasil-api' | 'yggdrasil-connect' | null
        descriptions: boolean
        unknownTables: { name: string; rows: number }[]
      }
    | {
        status: 'unreachable' | 'auth_failed' | 'database_missing' | 'not_blessing_skin' | 'failed'
        detail: string | null
      }
  textures: { readable: boolean; sampled: number; missing: number }
}
export interface ImportSourceDefaults {
  connection:
    | { dialect: 'sqlite'; file: string }
    | { dialect: 'mysql' | 'postgres'; host: string; port: number; database: string; username: string }
  prefix: string
  texturesDirectory: string
  timeZone: string
}
export interface ImportRunSummary {
  id: number
  status: ImportRunStatus
  dryRun: boolean
  entry: 'setup' | 'admin' | 'cli'
  startedBy: string | null
  startedAt: string
  finishedAt: string | null
  source: ImportSourceDefaults
  totals: { users: number; players: number; textures: number; blocking: number } | null
  error: string | null
}
export interface ImportGateway {
  maintenance(): boolean
  parseEnv(text: string, directory: string | null): ImportEnvForm
  check(input: ImportSourceInput): Promise<ImportCheckResult>
  start(
    input: ImportStartInput,
    meta: { entry: 'setup' | 'admin'; startedBy: string | null },
  ): Promise<{ token: string; state: ImportRunState }>
  run(token: string): ImportRunState | null
  cancel(token: string): ImportRunState | null
  runMarkdown(token: string): string | null
  listRuns(page: number, perPage: number): Promise<{ runs: ImportRunSummary[]; total: number }>
  getRun(id: number): Promise<{ run: ImportRunSummary; report: unknown } | null>
  runMarkdownById(id: number): Promise<string | null>
  lastSource(): Promise<ImportSourceDefaults | null>
}
