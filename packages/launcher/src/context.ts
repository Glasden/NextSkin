import type { CoreConfig } from '@nextskin/domain/config'

export interface LauncherContext {
  root: string
  home?: string
  cwd: string
  source: boolean
  production: boolean
  version: string
}

export function instanceDirectory(context: LauncherContext): string {
  return context.home ?? context.root
}

export interface CommandContext extends LauncherContext {
  config: CoreConfig
  env: NodeJS.ProcessEnv
  host: string
  port: number
}

/** 命令先检查自己的参数、处理 --help，再调用它读配置：参数写错时不用先有能用的配置，也不会生成 .env */
export type ReadCommandContext = () => Promise<CommandContext>
