import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 发行目录里的启动器（ADR-0039）：e2e 依赖 pnpm build 组装出的 dist/nextskin，服务和命令行都从这里运行
const entry = fileURLToPath(new URL('../../../dist/nextskin/nextskin.mjs', import.meta.url))

/**
 * 对某个服务的数据目录执行命令行，例如设定第一个超级管理员（ADR-0027），返回它写到 stdout 的内容。
 * 和运行中的服务共用一个 SQLite 文件，要用同一个密钥（playwright.config.ts）。stdin 不是终端
 */
export function nextskin(dataDirectory: string | undefined, ...args: string[]): string {
  if (!dataDirectory) throw new Error('没有这个服务的数据目录')
  return execFileSync(process.execPath, [entry, ...args], {
    // 六个服务共用发行目录；命令行也显式绕过管理进程，避免写入待打包的 releases/。
    env: {
      ...process.env,
      NEXTSKIN_MANAGER: 'off',
      NEXTSKIN_DATA_DIR: dataDirectory,
      NEXTSKIN_SECRET: process.env.NEXTSKIN_E2E_SECRET,
    },
    encoding: 'utf8',
  })
}

/** 管理实例使用自己的入口和默认 data/，也验证命令行按实例目录解析相对路径。 */
export function nextskinInstance(entry: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NEXTSKIN_SECRET: process.env.NEXTSKIN_E2E_SECRET }
  delete env.NEXTSKIN_MANAGER
  delete env.NEXTSKIN_DATA_DIR
  return execFileSync(process.execPath, [entry, ...args], { env, encoding: 'utf8' })
}
