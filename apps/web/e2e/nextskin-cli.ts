import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 发行目录里的启动器（ADR-0039）：e2e 依赖 pnpm build 组装出的 dist/nextskin，服务和命令行都从这里运行
const entry = fileURLToPath(new URL('../../../dist/nextskin/nextskin.mjs', import.meta.url))

/**
 * 对某个服务的数据目录执行命令行，例如设定第一个超级管理员（ADR-0027）。
 * 和运行中的服务共用一个 SQLite 文件，要用同一个密钥（playwright.config.ts）
 */
export function nextskin(dataDirectory: string | undefined, ...args: string[]): void {
  if (!dataDirectory) throw new Error('没有这个服务的数据目录')
  execFileSync(process.execPath, [entry, ...args], {
    env: { ...process.env, NEXTSKIN_DATA_DIR: dataDirectory, NEXTSKIN_SECRET: process.env.NEXTSKIN_E2E_SECRET },
  })
}
