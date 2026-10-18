// 从 BS v6 导入（ADR-0031）：安装向导、后台和命令行共用的导入引擎。迁移指南见 MIGRATION.md
export { runImport, checkImportOptions, ImportOptionsError, type ImportOptions, type ImportResult } from './engine.ts'
export { ImportCancelledError, type ImportProgress, type ImportStage } from './context.ts'
export type { ImportReport, BlockingIssue, UuidCandidate, UuidSource } from './report.ts'
export { reportToMarkdown, describeIssue } from './markdown.ts'
export { failInterruptedRuns, isSiteInitialized, lastImport } from './target.ts'
export { parseDotenv, readBsEnvironment, type BsEnvironment } from './source/env.ts'
export {
  parseSourceDsn,
  describeConnection,
  type SourceConnection,
  type SourceDescription,
} from './source/connection.ts'
export { SourceSchemaError } from './source/schema.ts'
